# EvEJS updater

`UpdateEveJS.bat` in the installation root opens this. It replaces the program
files with a new release while keeping everything the installation remembers.
The player-facing guide is [doc/UPDATING.md](../../doc/UPDATING.md).

Content packs are not its job. The server installs whatever is in the
`content-packs` folder when it starts, so the window has no tab for them. The
functions are still here and still work from a console -- see below -- so the
ability can be put back in the window if that is ever wanted.

| File | What it is |
|---|---|
| `Update-EvEJS.ps1` | the whole tool: window and update |
| `update-policy.json` | what an update keeps and what it replaces |

## Why PowerShell

The same reason `SetupEveJS.bat` is PowerShell: Docker users need no Node.js, and
this has to run on an installation that is broken or half-installed. It targets
Windows PowerShell 5.1, which is what ships with Windows.

## Handing it to someone who does not have it yet

`UpdateEveJS.bat` looks for the script beside itself first, then in
`tools\Updater`. So the three files copied into a folder of their own are a
complete standalone updater, which is how an installation older than this tool
gets one:

```
EveJS-Updater\
  UpdateEveJS.bat
  Update-EvEJS.ps1
  update-policy.json
```

Every release from this one on also ships it inside the installation.

## The policy file

Nothing in the script hard-codes a path. `update-policy.json` holds the lists,
and `server\tests\updaterPolicy.test.js` checks they stay in step with
`.gitignore`, the `compose.yaml` host mounts, the config manager's domain list
and the release builder's ship list. That test is the thing that stops a future
change from quietly moving somebody's certificates into a backup folder.

- `keepTrees`, `keepFiles`, `keepGlobs` — never moved. A bare `keepTrees` name
  matches a folder of that name at any depth; anything with a slash is anchored
  at the installation root. In a glob, `**/` means any depth and a lone `*` never
  crosses a folder boundary.
- `keepMine` — the operator's settings files. They are not moved *and* they are
  deleted from the unpacked release before it is copied in, so the new version
  cannot overwrite them. The server adds any new settings on its next start.
- `takeTheirs` — documents that `config\version.json` is deliberately replaced.
- `sourceTreeStoreGuards` — an installation keeping its game store in the source
  tree instead of `_local` is refused rather than guessed at.

`keepTrees` also prunes the file walk, so an update never enumerates the game
database, `node_modules`, or a Rust `target` directory.

## Running it without the window

```powershell
# What would change, touching nothing
powershell -File tools\Updater\Update-EvEJS.ps1 -NoGui -Preview -ZipPath C:\Downloads\EveJS-v0.12.8.zip

# Do it
powershell -File tools\Updater\Update-EvEJS.ps1 -NoGui -ZipPath C:\Downloads\EveJS-v0.12.8.zip

# Content packs. Not needed in normal use: the server installs the folder on
# startup. These are for support work, and the folder still wins on the next
# start, so a change made here only sticks if the folder agrees with it.
powershell -File tools\Updater\Update-EvEJS.ps1 -NoGui -ListPacks
powershell -File tools\Updater\Update-EvEJS.ps1 -NoGui -InstallPack C:\Downloads\evejs-ghost-sites-1.0.0.json
powershell -File tools\Updater\Update-EvEJS.ps1 -NoGui -ImportPackDir .\content-packs

# Accept a corrected build carrying a version that is already installed
powershell -File tools\Updater\Update-EvEJS.ps1 -NoGui -InstallPack <pack> -ReplacePacks
```

Both pack paths call the shipped `tools\ContentPacks` tool rather than touching
the store, so native and Docker behave the same. A console run never opens a dialog: where the window would
ask a yes/no question it declines and logs what it would have asked, which is why
replacing a same-version build needs `-ReplacePacks` on the command line.

Add `-InstallPath` when the script is not inside the installation it should act
on. `UpdateEveJS.bat /console` opens the window but leaves the console visible,
which is what to ask for when a run fails before the window appears.

## Notes for maintainers

- The script re-runs itself from a copy in `%TEMP%` when it is started from
  inside the installation it is about to rewrite. Without that, the update would
  move the running script out from under itself.
- Release zips are read whether they have a single version folder at the top or
  are flat, and whether their entry names use forward or back slashes.
- Old program files are moved, not deleted, into
  `_backup\pre-update-<version>-<stamp>\`. A failure at any point puts them back.
- Only files that belong to a release move. Each update writes
  `.evejs-installed-files.json` recording what it installed, so the next one can
  tell a file a release dropped from one the operator added; without that record
  it falls back to "does the release fill this folder?", and treats the
  installation root as shared. This is what stops a community tool under
  `tools\` being swept into `_backup` on every update.
- File moves and deletes go through the `\\?\` extended-path form: the backup
  folder adds about 40 characters to every path it holds, which is enough to push
  a deep installation past the 260-character limit.
