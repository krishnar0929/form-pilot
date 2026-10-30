// Clicking the toolbar icon (or Alt+Shift+F) opens the side panel.
const openOnClick = () =>
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(openOnClick);
chrome.runtime.onStartup.addListener(openOnClick);
openOnClick();
