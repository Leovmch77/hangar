#!/bin/bash
# usage: key.sh PID MODS KEY
hyprctl dispatch "hl.dsp.send_shortcut({ mods = '$2', key = '$3', window = 'pid:$1' })" >/dev/null
