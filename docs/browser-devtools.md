# Browser DevTools in the personal build

The collaborative browser exposes focused DevTools tools through each tab's server-owned CDP session. This works for headless tabs and desktop tabs connected through the existing CDP relay. Start with `preview_status` and `preview_open`. Each tool accepts an optional `tabId`; omitting it uses the agent session's current tab. Targets remain bound to the caller's thread. Diagnostic reads may inspect another session's tab in that thread; throttling and trace start/stop require agent control. These additions retain v0.1.0's orchestration protocol version 2.

| Tool                        | Use                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `preview_console`           | Recent console output and JavaScript exceptions, bounded stacks, level/ID filtering.           |
| `preview_network`           | Successful, pending and failed requests, stable IDs, status, size and duration.                |
| `preview_network_request`   | Headers and native timing fields; optional text response body.                                 |
| `preview_styles`            | Computed properties, inline/attribute declarations, matching rules and nearby inherited rules. |
| `preview_emulate`           | CPU slowdown and named network presets; `reset:true` clears both.                              |
| `preview_performance_start` | Begin a bounded Chromium performance trace.                                                    |
| `preview_performance_stop`  | Save a JSON trace to the agent's environment and return its path.                              |
| `preview_memory`            | Heap usage, DOM/listener counts and native performance counters.                               |

For a performance check, apply `{cpuRate:4, network:"fast-4g"}`, start a trace, navigate or interact, then stop the trace. Open the returned JSON in Chrome DevTools Performance or Perfetto. Finish with `preview_emulate({reset:true})`. Network presets are explicit approximations: fast 4G is 40 ms/4 Mbps down/3 Mbps up; slow 4G is 150 ms/1.6 Mbps down/750 Kbps up; 3G is 400 ms/400 Kbps each way. CPU throttling changes execution speed; viewport resizing remains a separate tool.

To check retained memory, repeat the same interaction several times and compare `preview_memory` results after each pass. First-pass growth alone is not evidence of a leak. These counters do not force garbage collection and do not replace a heap snapshot. Full heap snapshots are deliberately outside this first extension: they can pause the renderer and produce very large, sensitive object graphs, and need separate streaming/cancellation work.

Collection starts when automation attaches. Console history retains 200 entries; network history retains 100 requests. Missing response bodies are reported and never fetched again. Bodies are text only, opt-in and capped at 64 KiB. Authorization, proxy authorization, cookie, set-cookie and common API-token headers are redacted. URLs, page logs and explicitly requested response bodies can still contain application data. CSS inspection currently targets the main document with a CSS selector; results are bounded and are not a full cascade-winner classification.

Traces use a 4 MiB Chromium buffer, collect for at most 60 seconds, and stop automatically. The stop tool reports Chromium's data-loss flag; a trace with that flag is incomplete. Export is capped at 16 MiB. The server streams CDP data to a private file, then pulls 128 KiB chunks through the existing scoped broker to write the export in the agent environment. Trace bytes are not placed in the model's tool response. Transfer checks sizes and offsets, removes partial files on failure, and releases the temporary copy. Unclaimed copies expire after five minutes.

Opening human DevTools temporarily detaches agent control, as it did before this extension. Throttling is reset during debugger detach or tab closure. A navigation keeps it in effect until reset. No raw CDP command tool, arbitrary file read, new database schema, or new orchestration event is exposed.
