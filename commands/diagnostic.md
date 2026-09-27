---
description: Switch to debugging mode (what fails, what to try, still no internals)
---
The plugin already switched this session to DIAGNOSTIC before this prompt ran — do not call any tool. Check the `[communication-controller • mode: ...]` line in your system instructions: that is the live mode. Confirm in one short sentence that you will explain failures and next steps without implementation details. If no mode line is present, assume DIAGNOSTIC and say so.
