// Tests must not touch the network or the real policy mode: Jev is exercised by `bun run smoke` instead.
process.env.JEV_MODE = 'off';
// The agent review is a real model turn on a live guild server; unit tests exercise it with a stub reviewer.
process.env.REVIEW_MODE = 'off';
// A fake git server: the suite builds requests against it and pushes to a local bare repo, never over the network.
process.env.GIT_TOKEN = 'test-token';
process.env.GIT_BASE_URL = 'https://git.test';
// The turn watchdog is silence-based (10 min by default); the runtime test must not wait for that.
process.env.IDLE_TIMEOUT_MS = '120';
