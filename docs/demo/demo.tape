# Records docs/demo.gif and docs/screenshot.png. From the repo root:
#   make build && docs/demo/setup.sh && vhs docs/demo/demo.tape
Output docs/demo.gif

Require lazygit

Set Shell "bash"
Set FontSize 16
Set Width 1240
Set Height 620
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 90ms
Set Framerate 20

Hide
Type `export REPO=$PWD XDG_STATE_HOME=/tmp/lawnchy-demo/xdg XDG_CONFIG_HOME=/tmp/lawnchy-demo/xdg PS1='$ ' && lawnchy() { $REPO/dist/lawnchy "$@"; } && cd /tmp/lawnchy-demo/code && clear`
Enter
Sleep 500ms
Show

Type "lawnchy"
Sleep 400ms
Enter
Sleep 2500ms
Screenshot docs/screenshot.png

Down@350ms 3
Sleep 1000ms
Type@120ms "b"
Sleep 1800ms
Type@120ms "b"
Sleep 800ms
Type@120ms "/"
Sleep 500ms
Type@150ms "^acme"
Sleep 1500ms
Escape
Sleep 1000ms
Type@120ms "x"
Sleep 2000ms
Escape
Sleep 800ms
Type@120ms "k"
Sleep 400ms
Type@120ms "o"
Sleep 3000ms
Type@120ms "q"
Sleep 1500ms
Type@120ms "q"
Sleep 500ms
