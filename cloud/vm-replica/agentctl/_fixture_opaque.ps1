param([string]$Title = "DaoOpaque")
# A deterministic *semantically-opaque* window: it has pixels but exposes NO
# operable application control to UIA — the synthetic twin of a GTK-on-Windows app
# (Inkscape), a game, or a pure <canvas>. Its whole content is one Border with a
# click handler that repaints it red; a Border/Rectangle is not a UIA actionable
# control, so the meaning floor sees only the window-frame chrome (TitleBar +
# Minimize/Maximize/Close), exactly like Inkscape. Yet it is fully operable by the
# PIXEL channel: click its centre and the pixel goes white -> red.
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="__TITLE__" Width="420" Height="360" Left="60" Top="60" Topmost="True">
  <Border x:Name="surface" Background="White"/>
</Window>
"@

$xaml = $xaml -replace '__TITLE__', $Title
$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$win = [Windows.Markup.XamlReader]::Load($reader)
$surface = $win.FindName("surface")
$surface.Add_MouseLeftButtonDown({
    $surface.Background = [System.Windows.Media.Brushes]::Red
})

[void]$win.ShowDialog()
