# FormPilot

Chrome extension that reads the form on the current page and uses Claude to **fill**, **judge**, or **check** it. Every suggestion appears in a side panel for you to edit and approve; FormPilot fills only the fields you tick and never clicks Submit.

## Modes
- **Fill** – completes forms from your "About me" profile, your guidance and the page.
- **Judge** – reads the submission + rubric on the page (plus a screenshot and any PDFs you attach) and drafts scores and comments for each criterion.
- **Check** – reviews what's already entered and flags gaps, typos and score/comment mismatches.

## Install (developer mode)
1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → choose the `formpilot` folder.
3. Pin FormPilot, click the icon (or press **Alt+Shift+F**) to open the side panel.
4. In **Settings**, paste your Anthropic API key (console.anthropic.com).

## Use
1. Open the page with the form (e.g. a review modal).
2. Pick a mode, add optional guidance, attach the submission PDF if it isn't on the page.
3. Press **Judge with AI** (or Fill / Check). Review each card, edit, untick anything you don't want.
4. Press **Fill selected**, check the page, and submit yourself.

## Test locally
Open `test/review-form.html` in Chrome (enable "Allow access to file URLs" for the extension) and run Judge.

## Notes & limits
- Your API key and profile are stored in `chrome.storage.local` and sent only to `api.anthropic.com`.
- Fields inside iframes aren't scanned yet. Chrome pages and the Web Store can't be scripted.
- When a modal/dialog is open, only its fields are scanned; the whole page text is still sent as context.
- Many judging programs expect the reviewer's own assessment — use AI scores as a draft and follow the program's rules.

## Testing with a saved key (temporary)
To avoid pasting the key each time while testing:
```bash
cp config.example.js config.local.js   # config.local.js is git-ignored
# edit config.local.js and paste your key, then reload the extension
```
The key from `config.local.js` is used whenever no key is saved in Settings, and is copied into Chrome storage on first load. Remove the file before publishing.
