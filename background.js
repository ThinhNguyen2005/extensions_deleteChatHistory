// Gemini History Cleaner Background Script

// Listen for clicks on the extension's toolbar icon
chrome.action.onClicked.addListener((tab) => {
  // With 'activeTab' permission, tab.url should be populated when clicked.
  // We check if it is Gemini, or if URL is empty (fallback) we still attempt to send the message.
  if (!tab.url || tab.url.includes('gemini.google.com')) {
    chrome.tabs.sendMessage(tab.id, { action: "toggle_cleaner" }).catch((err) => {
      console.warn("Could not communicate with content script. Try reloading the Gemini page.", err);
    });
  }
});
