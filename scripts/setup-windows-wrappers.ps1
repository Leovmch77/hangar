<#
.SYNOPSIS
  Grava (ou atualiza) o bloco dos wrappers do Hangar nos perfis do PowerShell.

.DESCRIPTION
  O mesmo passo 5/8 do install.ps1, sozinho: e o que o botao Consertar do painel de saude roda no
  Windows. Sem ele, um wrapper faltando no Windows nao tinha conserto pelo app, so reinstalando.
  Sai 1 se algum perfil ficou sem o bloco.

.EXAMPLE
  .\scripts\setup-windows-wrappers.ps1 -Apply
#>
param([switch]$Apply)

$raiz = Split-Path -Parent $PSScriptRoot
function Ok($m)    { Write-Host "ok  $m" }
function Nota($m)  { Write-Host "    $m" }
function Falta($m) { Write-Host "--  $m" }
. "$raiz\scripts\windows-wrappers.ps1"

$perfis = Perfis-Do-Usuario
if (-not $Apply) {
    foreach ($pf in $perfis) {
        $tem = (Test-Path $pf) -and ((Ler-Texto $pf) -match [regex]::Escape($MarcaWrapper))
        Write-Output ("{0}  bloco={1}" -f $pf, $tem)
    }
    exit 0
}
if (Instalar-Wrappers $perfis) { exit 0 }
exit 1
