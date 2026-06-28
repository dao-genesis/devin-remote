param([string]$Title = "DaoDelay")
# A deterministic *time-varying* window for the semantic-wait probe (F206). It opens
# showing a "spinner" TextBlock and NO "ready" button; two DispatcherTimers then make
# the GUI change after the window is already up, exactly like a real app:
#   * ~1.4s after load: a Button named "ready" is ADDED (a dialog control appearing
#     a beat after its trigger).
#   * ~2.6s after load: the "spinner" TextBlock is REMOVED (a busy indicator clearing).
# So wait_control(win,'ready') must block-then-succeed, and wait_control_gone(win,
# 'spinner') must block-then-succeed — neither is true at the instant the window opens.
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="__TITLE__" Width="420" Height="300" Left="80" Top="80" Topmost="True">
  <StackPanel x:Name="panel" Margin="20">
    <TextBlock x:Name="spinner" Text="Loading..." AutomationProperties.Name="spinner"/>
    <TextBox x:Name="field" AutomationProperties.Name="field" Height="26" Margin="0,12,0,0"/>
  </StackPanel>
</Window>
"@

$xaml = $xaml -replace '__TITLE__', $Title
$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$win = [Windows.Markup.XamlReader]::Load($reader)
$panel = $win.FindName("panel")
$spinner = $win.FindName("spinner")

$add = New-Object System.Windows.Threading.DispatcherTimer
$add.Interval = [TimeSpan]::FromMilliseconds(1400)
$add.Add_Tick({
    $btn = New-Object System.Windows.Controls.Button
    $btn.Content = "ready"
    [System.Windows.Automation.AutomationProperties]::SetName($btn, "ready")
    [void]$panel.Children.Add($btn)
    $add.Stop()
})

$rem = New-Object System.Windows.Threading.DispatcherTimer
$rem.Interval = [TimeSpan]::FromMilliseconds(2600)
$rem.Add_Tick({
    $panel.Children.Remove($spinner)
    $rem.Stop()
})

$win.Add_Loaded({ $add.Start(); $rem.Start() })
[void]$win.ShowDialog()
