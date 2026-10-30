// TEMPORARY, for local testing only.
// 1. Copy this file to config.local.js (that file is git-ignored and never committed).
// 2. Paste your Anthropic API key below.
// 3. Reload the extension in chrome://extensions.
// Do not ship a build with a real key in it.
window.FORMPILOT_CONFIG = {
  apiKey: 'sk-ant-PASTE-YOUR-KEY-HERE',
  model: 'claude-sonnet-5-5',   // or claude-opus-5-5 / claude-haiku-5-5
  mode: 'judge',                // default mode: fill | judge | check
  profile: '',                  // optional "About me" for Fill mode
  autofill: true,               // fill the page right after Claude answers
};
