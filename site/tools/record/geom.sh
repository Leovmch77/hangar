#!/bin/bash
hyprctl clients -j | jq -r --argjson p "$1" '.[] | select(.pid==$p) | "\(.at[0]),\(.at[1]) \(.size[0])x\(.size[1])"'
