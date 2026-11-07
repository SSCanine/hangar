<#
  One-time (and safe to repeat) Windows registration for Hangar, current user only:
  - AppUserModelId "Hangar.App": lets Hangar's notifications show as "Hangar" with its icon.
  - URL protocol hangar:// : clicking a Hangar notification opens Hangar at that conversation.
  Hangar also runs the protocol part at every start, so the exe path stays current.
#>
param([string]$Exe = (Join-Path $PSScriptRoot "..\src-tauri\target\release\hangar.exe"))
$Exe = [System.IO.Path]::GetFullPath($Exe)
$icon = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\src-tauri\icons\128x128.png"))

$aumid = "HKCU:\Software\Classes\AppUserModelId\Hangar.App"
New-Item -Path $aumid -Force | Out-Null
Set-ItemProperty -Path $aumid -Name DisplayName -Value "Hangar"
Set-ItemProperty -Path $aumid -Name IconUri -Value $icon
Set-ItemProperty -Path $aumid -Name ShowInSettings -Value 1 -Type DWord

$proto = "HKCU:\Software\Classes\hangar"
New-Item -Path "$proto\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $proto -Name "(default)" -Value "URL:Hangar"
Set-ItemProperty -Path $proto -Name "URL Protocol" -Value ""
Set-ItemProperty -Path "$proto\shell\open\command" -Name "(default)" -Value "`"$Exe`" `"%1`""
Write-Output "registered Hangar.App and hangar:// -> $Exe"
