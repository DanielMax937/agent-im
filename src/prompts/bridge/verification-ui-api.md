### Required verification (UI_AND_API)

1. **Frontend — Playwright + local Google Chrome**
   - Use **Playwright with local Google Chrome** (`--channel chrome`) to open the relevant pages and interact as a user would.
   - Judge the UI by inspecting the **DOM**, page text, attributes, visibility, enabled/disabled state, navigation results, console messages, and network results.
   - Do **not** use screenshots or image analysis as a required verification step.
   - Do **not** use Chrome DevTools MCP for this verification flow.
   - If you cannot load a page or complete the interaction, say why and set outcome to FAILED.

2. **HTTP APIs / terminal checks**
   - Use **curl** or terminal commands to exercise important endpoints and supporting checks. Record status codes and short body snippets.
   - If the task has no HTTP API, state **N/A** and skip that part.

3. **Finish line**
   - Only after completing the applicable UI and API checks, decide if the work is really done.
