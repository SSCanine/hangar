<#
  Shows one Windows notification for Hangar. Called by hangar_notify.py (hidden, Windows PowerShell 5.1,
  which has the WinRT toast API). Clicking it, or "Open conversation", opens hangar://session/<id>;
  "Read aloud" opens hangar://read/<inbox id>. The toast itself is silent: the hook already chimed.
#>
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$Body = "",
    [string]$Attribution = "",
    [string]$OpenUrl = "",
    [string]$ReadUrl = ""
)
$ErrorActionPreference = "Stop"
$AppId = "Hangar.App"

function Esc([string]$s) { [System.Security.SecurityElement]::Escape($s) }

$launch = if ($OpenUrl) { " activationType=`"protocol`" launch=`"$(Esc $OpenUrl)`"" } else { "" }
$actions = ""
if ($OpenUrl -or $ReadUrl) {
    $actions = "<actions>"
    if ($OpenUrl) { $actions += "<action content=`"Open conversation`" activationType=`"protocol`" arguments=`"$(Esc $OpenUrl)`"/>" }
    if ($ReadUrl) { $actions += "<action content=`"Read aloud`" activationType=`"protocol`" arguments=`"$(Esc $ReadUrl)`"/>" }
    $actions += "</actions>"
}
$attr = if ($Attribution) { "<text placement=`"attribution`">$(Esc $Attribution)</text>" } else { "" }
$xmlText = @"
<toast$launch>
  <visual><binding template="ToastGeneric">
    <text>$(Esc $Title)</text>
    <text>$(Esc $Body)</text>
    $attr
  </binding></visual>
  $actions
  <audio silent="true"/>
</toast>
"@

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlText)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
$toast.Tag = ($OpenUrl -replace '[^A-Za-z0-9]', '').Substring(0, [Math]::Min(16, ($OpenUrl -replace '[^A-Za-z0-9]', '').Length))
$toast.Group = "hangar"
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
