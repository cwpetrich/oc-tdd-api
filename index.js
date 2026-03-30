const express = require("express");
const { execSync } = require("child_process");
const path = require("path");

const app = express();
const PORT = 6001;
const REPO = "cwpetrich/decktician";
const CACHE_TTL_MS = 20_000;

let cache = { data: null, ts: 0 };

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

// Serve dashboard
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "tdd-dashboard.html"));
});

app.get("/api/tdd-status", async (req, res) => {
  try {
    const now = Date.now();
    if (cache.data && now - cache.ts < CACHE_TTL_MS) {
      return res.json(cache.data);
    }

    const result = await buildStatus();
    cache = { data: result, ts: now };
    res.json(result);
  } catch (err) {
    console.error("Error building status:", err);
    res.status(500).json({ error: err.message });
  }
});

async function buildStatus() {
  // A) GitHub issues with state: labels
  const issuesRaw = execSafe(
    `gh issue list --repo ${REPO} --state open --json number,title,labels,url --limit 50`
  );
  const allIssues = JSON.parse(issuesRaw || "[]");

  const buckets = { ready: [], red: [], green: [], review: [], blocked: [] };

  for (const issue of allIssues) {
    const stateLabels = (issue.labels || [])
      .map((l) => l.name)
      .filter((n) => n.startsWith("state:"));
    for (const label of stateLabels) {
      const key = label.replace("state:", "");
      if (buckets[key]) {
        buckets[key].push({
          number: issue.number,
          title: issue.title,
          url: issue.url,
        });
      }
    }
  }

  // B) Active PRs
  const prsRaw = execSafe(
    `gh pr list --repo ${REPO} --state open --json number,title,headRefName,isDraft,url,statusCheckRollup`
  );
  const allPRs = JSON.parse(prsRaw || "[]");

  const activeBuckets = ["red", "green", "review"];
  for (const bucket of activeBuckets) {
    for (const issue of buckets[bucket]) {
      issue.pr = findPRForIssue(issue.number, allPRs);
    }
  }

  // C) Active agents
  const agentsRaw = execSafe(`openclaw sessions --active 15 --json 2>/dev/null`);
  let agents = [];
  try {
    const sessions = JSON.parse(agentsRaw || "[]");
    agents = sessions
      .filter(
        (s) =>
          s.sessionKey &&
          s.sessionKey.includes("ender") &&
          s.status === "active"
      )
      .map((s) => ({
        sessionKey: s.sessionKey,
        task: s.task || s.description || "",
        status: s.status,
        runtimeMs: s.runtimeMs || 0,
      }));
  } catch {
    // openclaw may not be available
  }

  return {
    updatedAt: new Date().toISOString(),
    issues: buckets,
    agents,
  };
}

function findPRForIssue(issueNumber, prs) {
  const pr = prs.find((p) => {
    const titleMatch = p.title && p.title.includes(`#${issueNumber}`);
    const branchMatch =
      p.headRefName && p.headRefName.includes(`${issueNumber}`);
    return titleMatch || branchMatch;
  });
  if (!pr) return null;

  let ciStatus = "unknown";
  if (pr.statusCheckRollup && pr.statusCheckRollup.length > 0) {
    const states = pr.statusCheckRollup.map((c) =>
      (c.conclusion || c.status || "").toUpperCase()
    );
    if (states.some((s) => s === "FAILURE" || s === "ERROR")) {
      ciStatus = "failing";
    } else if (states.every((s) => s === "SUCCESS")) {
      ciStatus = "passing";
    } else {
      ciStatus = "pending";
    }
  }

  return {
    number: pr.number,
    isDraft: pr.isDraft,
    ciStatus,
    url: pr.url,
  };
}

function execSafe(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 15_000 });
  } catch {
    return "[]";
  }
}

app.listen(PORT, () => {
  console.log(`oc-tdd-api listening on port ${PORT}`);
});
