# Let phones on the home network reach Hangar Remote on TCP 3622. Needs an elevated PowerShell
# (right-click > Run with PowerShell as administrator).
# LocalSubnet = only devices on the same network as this PC; Hangar itself also refuses anything
# outside private ranges and every call needs a paired phone's token.
$name = "Hangar Remote 3622 (home network only)"
if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort 3622 `
        -RemoteAddress LocalSubnet -Profile Any -Action Allow | Out-Null
}
Get-NetFirewallRule -DisplayName $name | Select-Object DisplayName, Enabled, Profile | Format-Table -AutoSize
Write-Host "Done. This window closes in 5 seconds."
Start-Sleep -Seconds 5
