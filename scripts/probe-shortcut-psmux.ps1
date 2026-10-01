$ErrorActionPreference = 'Continue'
$s = 'cxprobe-hangar'
$dir = Join-Path $env:LOCALAPPDATA 'Hangar\shortcuts'
New-Item -ItemType Directory -Force $dir | Out-Null
function Fresh { tmux kill-session -t $s 2>$null | Out-Null; Start-Sleep -Milliseconds 300 }
# PID 0/4 e o sistema: sessao que nao subiu deixa o pid em 0, e `taskkill /T /F /PID 0` nao pode rodar.
function KillTree([int]$procId) {
    if ($procId -le 4) { "TASKKILL_SKIPPED pid=$procId"; return }
    taskkill /T /F /PID $procId | Out-Null; "TASKKILL_RC=$LASTEXITCODE"
}

# 1. .cmd com codigo de saida em arquivo e pause em laco segurando o pane. `exit 3` SEM /b no
#    comando (o caso que mata um `call`), pasta com espaco e acento no caminho.
Fresh
$dir2 = Join-Path $dir 'com espaço'; New-Item -ItemType Directory -Force $dir2 | Out-Null
$cmd = Join-Path $dir2 'cxprobe-cmd.cmd'; $exit = Join-Path $dir2 'cxprobe.exit'
Remove-Item $exit -ErrorAction SilentlyContinue
Set-Content -Encoding Oem $cmd "@echo off`r`necho saindo`r`nexit 3"
$wrap = Join-Path $dir2 'cxprobe.cmd'
Set-Content -Encoding Oem $wrap "@cmd /d /c `"$cmd`"`r`n@>`"$exit`" echo %ERRORLEVEL%`r`n:h`r`n@pause >nul`r`n@goto h"
# Argumentos separados: o PowerShell 5.1 estraga aspas embutidas numa string unica.
tmux new-session -d -s $s -x 120 -y 30 -- cmd /d /c $wrap
Start-Sleep 2
"EXITFILE=" + (Get-Content $exit -ErrorAction SilentlyContinue)
"ALIVE_AFTER=" + (tmux list-sessions -F '#{session_name}|#{pane_dead}' | Select-String $s)
tmux send-keys -t "=${s}:" x; Start-Sleep 1
"ALIVE_AFTER_KEY=" + (tmux list-sessions -F '#{session_name}|#{pane_dead}' | Select-String $s)

# 2. opcoes em chamadas separadas logo depois do new-session
tmux set-option -t "=${s}:" '@cp_hidden' '1'; "OPT_RC=$LASTEXITCODE"
"OPT_READ=" + (tmux list-sessions -F '#{session_name}|#{@cp_hidden}' | Select-String $s)

# 3. matar a arvore e a sessao
$pp = [int](tmux display -p -t "=${s}:" '#{pane_pid}')
KillTree $pp
tmux kill-session -t $s 2>$null; Start-Sleep 1
tmux has-session -t "=$s" 2>$null; "GONE=" + ($LASTEXITCODE -ne 0)

# 4. pergunta falsa: prompt impresso + Start-Sleep (CPU e tela parados)
Fresh
tmux new-session -d -s $s -x 120 -y 30 -- powershell -NoProfile -Command 'Write-Host -NoNewline "Porta: "; Start-Sleep 60'
Start-Sleep 3
$pp = [int](tmux display -p -t "=${s}:" '#{pane_pid}')
$c1 = (Get-Process -Id $pp).TotalProcessorTime.TotalMilliseconds; Start-Sleep 2
$c2 = (Get-Process -Id $pp).TotalProcessorTime.TotalMilliseconds
"SLEEP_CPU_DELTA_MS=" + ($c2 - $c1)

# 5. pergunta real: Read-Host
Fresh
tmux new-session -d -s $s -x 120 -y 30 -- powershell -NoProfile -Command '$p = Read-Host "Porta [3000]"; Start-Sleep 60'
Start-Sleep 3
$pp = [int](tmux display -p -t "=${s}:" '#{pane_pid}')
$c1 = (Get-Process -Id $pp).TotalProcessorTime.TotalMilliseconds; Start-Sleep 2
$c2 = (Get-Process -Id $pp).TotalProcessorTime.TotalMilliseconds
"READ_CPU_DELTA_MS=" + ($c2 - $c1)
"READ_LINE=" + ((tmux capture-pane -p -t "=${s}:") | Where-Object { $_ -ne '' } | Select-Object -Last 1)

# 6. janela propria: notepad aberto pelo pane, o backend consegue trazer pra frente?
Fresh
tmux new-session -d -s $s -x 120 -y 30 -- cmd /d /c "notepad & pause >nul"
Start-Sleep 3
$pp = [int](tmux display -p -t "=${s}:" '#{pane_pid}')
$kids = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $pp } | ForEach-Object { "$($_.ProcessId):$($_.Name)" }
"CHILDREN=" + ($kids -join ',')
"SESSION_ID_PANE=" + (Get-Process -Id $pp).SessionId + " SESSION_ID_ME=" + (Get-Process -Id $PID).SessionId

Fresh
Remove-Item -Recurse -Force $dir2 -ErrorAction SilentlyContinue
