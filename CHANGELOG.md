1.3.7
- Changed to use `/bin/sh` instead of `/bin/bash` to make it work on systems without bash #3

1.3.6
- Fixed an error on systems using older versions of sudo #2

1.3.5
- Added support for untrusted workspaces.
  This extension does nothing until you run the command, so it is safe to enable it in untrasted workspaces.

1.3.4
- Made tiny changes to comments and descriptions.

1.3.3
- Deleted unused files and made the code more readable. There is no change in behavior.

1.3.2
- Added error handling code

1.3.1
- Replaced exec() with spawn()
- Edited the display name

1.3.0
- Implemented password input

1.2.1
- Edited the display name and the description

1.2.0
- Use `File: Revert File` instead of reopening files so that the native save dialog would'nt be displayed

1.1.1
- Fix: When saving files VSCode tries to open backed up data and throws error

1.1.0
- Fix: Error when creating a file in a non-existent directory 
- Added an icon
- Use showSaveDialog() when saving untitled files

1.0.0
- Initial release
