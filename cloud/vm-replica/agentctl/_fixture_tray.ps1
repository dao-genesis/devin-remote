param([string]$Title = "DaoTray", [string]$Sentinel = "$env:TEMP\daotray.txt")
# A deterministic system-tray fixture: a WinForms app that owns a NotifyIcon in
# the notification area and a ContextMenuStrip, while its only Form stays HIDDEN
# (ShowInTaskbar=$false, never shown). So the process has NO normal top-level
# window at all — it lives purely in the tray. Exercises the agentctl floor's
# ability to reach an app that has retreated entirely off the workspace.
#
# The context menu items, when chosen, write a line to $Sentinel so a probe can
# verify the effect with no visible window to read.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ctx = New-Object System.Windows.Forms.ContextMenuStrip
$itemPing = $ctx.Items.Add("Ping Sentinel")
$itemMark = $ctx.Items.Add("Mark Done")
$itemQuit = $ctx.Items.Add("Quit")

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = [System.Drawing.SystemIcons]::Application
$ni.Text = $Title          # the tooltip — the icon's accessible Name
$ni.Visible = $true
$ni.ContextMenuStrip = $ctx

$itemPing.add_Click({ Add-Content -Path $Sentinel -Value ("PING " + (Get-Date -Format o)) })
$itemMark.add_Click({ Add-Content -Path $Sentinel -Value ("MARK " + (Get-Date -Format o)) })
$itemQuit.add_Click({ $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() })

# hidden message-only-ish form: required to pump the WinForms message loop, but
# never shown and kept off the taskbar, so no top-level app window exists.
$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false
$form.WindowState = 'Minimized'
$form.FormBorderStyle = 'FixedToolWindow'
$form.Opacity = 0
$form.add_Load({ $form.Visible = $false })

[System.Windows.Forms.Application]::Run($form)
