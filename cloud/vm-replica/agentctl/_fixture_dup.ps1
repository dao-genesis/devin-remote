param([string]$Title = "DaoDup")
# A deterministic reproduction of the Notepad++ Replace-dialog friction (F207): a
# field's caption is a static Text carrying the SAME accessible name as the editable
# control it labels. Here a TextBlock and a TextBox are both named "email"; the label
# sits first in tree order, so a naive find-by-name returns the uneditable caption and
# a write silently no-ops. Also a read-only TextBox named "locked" (SetValue would
# return S_OK yet change nothing) and a uniquely named "solo" field for regression.
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="__TITLE__" Width="420" Height="320" Left="80" Top="80" Topmost="True">
  <StackPanel Margin="20">
    <TextBlock Text="email" AutomationProperties.Name="email"/>
    <TextBox x:Name="email_box" AutomationProperties.Name="email" Height="26"/>
    <TextBlock Text="locked" AutomationProperties.Name="locked" Margin="0,12,0,0"/>
    <TextBox x:Name="locked_box" AutomationProperties.Name="locked" Height="26"
             IsReadOnly="True" Text="ORIG"/>
    <TextBlock Text="solo" AutomationProperties.Name="solo" Margin="0,12,0,0"/>
    <TextBox x:Name="solo_box" AutomationProperties.Name="solo" Height="26"/>
  </StackPanel>
</Window>
"@

$xaml = $xaml -replace '__TITLE__', $Title
$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$win = [Windows.Markup.XamlReader]::Load($reader)
[void]$win.ShowDialog()
