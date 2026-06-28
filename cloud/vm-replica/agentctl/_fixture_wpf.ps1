param([string]$Title = "DaoWpf")
# A deterministic WPF fixture (full native UIA provider) exposing one of every
# UIA-bearing control, so the agentctl Windows semantic floor (uia_*) is exercised
# against a first-class UIA surface (WPF, unlike WinForms, exposes RangeValue,
# ExpandCollapse, ScrollItem and Text patterns properly).
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$zh = -join ([char]0x9053,[char]0x6cd5,[char]0x81ea,[char]0x7136)
$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:a="clr-namespace:System.Windows.Automation;assembly=PresentationCore"
        Title="__TITLE__" Width="540" Height="640" Left="40" Top="40" Topmost="True">
  <StackPanel Margin="12">
    <TextBox x:Name="field" a:AutomationProperties.Name="field" Height="26" Margin="0,4"/>
    <CheckBox x:Name="agree" a:AutomationProperties.Name="agree" Content="I agree" Margin="0,4"/>
    <ComboBox x:Name="fruit" a:AutomationProperties.Name="fruit" Width="200" HorizontalAlignment="Left" Margin="0,4">
      <ComboBoxItem a:AutomationProperties.Name="apple">apple</ComboBoxItem>
      <ComboBoxItem a:AutomationProperties.Name="banana">banana</ComboBoxItem>
      <ComboBoxItem a:AutomationProperties.Name="cherry">cherry</ComboBoxItem>
    </ComboBox>
    <Slider x:Name="level" a:AutomationProperties.Name="level" Minimum="0" Maximum="100" Value="10" Margin="0,8"/>
    <ListBox x:Name="nums" a:AutomationProperties.Name="nums" Height="120" Margin="0,4"/>
    <TreeView x:Name="tree" a:AutomationProperties.Name="tree" Height="110" Margin="0,4">
      <TreeViewItem x:Name="rootnode" a:AutomationProperties.Name="Root" Header="Root">
        <TreeViewItem a:AutomationProperties.Name="Child One" Header="Child One"/>
        <TreeViewItem a:AutomationProperties.Name="Child Two" Header="Child Two"/>
      </TreeViewItem>
    </TreeView>
    <Button x:Name="ping" a:AutomationProperties.Name="ping" Content="Ping" Width="120" HorizontalAlignment="Left" Margin="0,6"/>
    <TextBox x:Name="doc" a:AutomationProperties.Name="doc" Height="120" Margin="0,4"
             IsReadOnly="True" TextWrapping="Wrap" AcceptsReturn="True"
             VerticalScrollBarVisibility="Auto"/>
  </StackPanel>
</Window>
"@

$xaml = $xaml -replace '__TITLE__', $Title
$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$win = [Windows.Markup.XamlReader]::Load($reader)

$win.FindName("doc").Text = "line alpha`r`nline beta $zh`r`nline gamma"
$nums = $win.FindName("nums")
0..40 | ForEach-Object { [void]$nums.Items.Add("row-$_") }
$field = $win.FindName("field")
$win.FindName("ping").Add_Click({ $field.Text = "PONG" })

[void]$win.ShowDialog()
