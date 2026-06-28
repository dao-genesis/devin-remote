# A deterministic WinForms fixture exposing one of every UIA-bearing control type,
# so the agentctl Windows semantic floor (uia_*) can be exercised end-to-end.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$f = New-Object System.Windows.Forms.Form
$f.Text = "DaoFixture"
$f.Size = New-Object System.Drawing.Size(520, 640)
$f.StartPosition = "Manual"
$f.Location = New-Object System.Drawing.Point(40, 40)
$f.TopMost = $true

# Edit (TextBox)
$tb = New-Object System.Windows.Forms.TextBox
$tb.AccessibleName = "field"; $tb.Location = '20,20'; $tb.Size = '460,24'
$f.Controls.Add($tb)

# CheckBox
$cb = New-Object System.Windows.Forms.CheckBox
$cb.AccessibleName = "agree"; $cb.Text = "I agree"; $cb.Location = '20,56'; $cb.Size = '200,24'
$f.Controls.Add($cb)

# ComboBox (dropdown -> ExpandCollapse; items -> ListItem select)
$cmb = New-Object System.Windows.Forms.ComboBox
$cmb.AccessibleName = "fruit"; $cmb.Location = '20,88'; $cmb.Size = '200,24'
$cmb.DropDownStyle = "DropDown"
[void]$cmb.Items.AddRange(@("apple","banana","cherry","date"))
$f.Controls.Add($cmb)

# TrackBar (Slider -> RangeValue)
$tk = New-Object System.Windows.Forms.TrackBar
$tk.AccessibleName = "level"; $tk.Location = '20,120'; $tk.Size = '460,40'
$tk.Minimum = 0; $tk.Maximum = 100; $tk.Value = 10; $tk.TickFrequency = 10
$f.Controls.Add($tk)

# ListBox (List + ListItem -> select / is_selected / scroll_into_view)
$lb = New-Object System.Windows.Forms.ListBox
$lb.AccessibleName = "nums"; $lb.Location = '20,170'; $lb.Size = '200,160'
0..40 | ForEach-Object { [void]$lb.Items.Add("row-$_") }
$f.Controls.Add($lb)

# TreeView (Tree + TreeItem -> expand / collapse)
$tv = New-Object System.Windows.Forms.TreeView
$tv.AccessibleName = "tree"; $tv.Location = '240,170'; $tv.Size = '240,160'
$root = $tv.Nodes.Add("rootnode","Root")
[void]$root.Nodes.Add("child1","Child One")
[void]$root.Nodes.Add("child2","Child Two")
$f.Controls.Add($tv)

# Button (Invoke) -> writes result into the label below
$lblOut = New-Object System.Windows.Forms.Label
$lblOut.AccessibleName = "result"; $lblOut.Location = '20,400'; $lblOut.Size = '460,24'
$lblOut.Text = "idle"
$f.Controls.Add($lblOut)

$btn = New-Object System.Windows.Forms.Button
$btn.AccessibleName = "ping"; $btn.Text = "Ping"; $btn.Location = '20,360'; $btn.Size = '120,30'
$btn.Add_Click({ $lblOut.Text = "PONG" })
$f.Controls.Add($btn)

# A read-only multiline text region (uia_text)
$rt = New-Object System.Windows.Forms.TextBox
$rt.AccessibleName = "doc"; $rt.Location = '20,430'; $rt.Size = '460,140'
$rt.Multiline = $true; $rt.ReadOnly = $true; $rt.ScrollBars = "Vertical"
$zh = -join ([char]0x9053,[char]0x6cd5,[char]0x81ea,[char]0x7136)
$rt.Text = "line alpha`r`nline beta $zh`r`nline gamma"
$f.Controls.Add($rt)

[void]$f.ShowDialog()
