---
description: Switch to unrestricted engineering mode (full implementation detail)
---
The plugin already switched this session to ENGINEERING before this prompt ran — do not call any tool. Check the `[communication-controller • mode: ...]` line in your system instructions: that is the live mode. Confirm in one short sentence that full engineering detail will now be shown. If no mode line is present, assume ENGINEERING and say so.
