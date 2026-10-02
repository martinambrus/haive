# MCP server consent

**A committed MCP server list is not consent on another install.** `12-post-onboarding` commits
`.haive-data/tooling.json`, and `loadUserMcpServers` hands its `mcpSettingsJson` to every CLI, so a
clone used to run whatever servers the repository named, past the explicit opt-in 04 asks for
(`keepRepoMcpServers`). 04 records the list it writes, the servers that opt-in keeps included,
since the runtime and 07's rewrite read the record and never the file, and refuses the opt-in
once the file no longer holds the definitions its form named (`mcpServersFingerprint`).
`importHaiveDataMirror` now moves a list holding anything but Haive's own
definitions to `importedMcpSettingsJson`, which nothing reads, and the tooling page asks: accept
puts it back, discard drops it. A server counts as Haive's only when its definition EQUALS Haive's
under that name (`mcpServersNeedingConsent`), since a file can put any command under
`chrome-devtools`. The three keys (`ONBOARDING_TOOLING_CONSENT_KEYS`) are this install's decision:
stripped from an incoming mirror and never committed. Acceptance is an HMAC of the list keyed with
the install's encryption key (`mcpAcceptanceMark`), never a plain hash: an older release's import
stored the committed tooling verbatim, so a file could carry a matching hash of its own list.
`holdImportedMcpServerLists` holds such rows at boot. A record this install's own 04 wrote equals
that run's `output.tooling`, so only one matching no local 04 run is held, and the mark keeps an
accepted list from being held again.
