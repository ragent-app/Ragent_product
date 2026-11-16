using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class RagentSetup {
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiOpenDatabaseW")] private static extern uint MsiOpenDatabase(string path, IntPtr persist, out uint db);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiDatabaseOpenViewW")] private static extern uint MsiDatabaseOpenView(uint db, string sql, out uint view);
    [DllImport("msi.dll")] private static extern uint MsiViewExecute(uint view, uint record);
    [DllImport("msi.dll")] private static extern uint MsiViewFetch(uint view, out uint record);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiRecordGetStringW")] private static extern uint MsiRecordGetString(uint record, uint field, StringBuilder value, ref uint length);
    [DllImport("msi.dll")] private static extern uint MsiCloseHandle(uint handle);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiEnumRelatedProductsW")] private static extern uint MsiEnumRelatedProducts(string upgradeCode, uint reserved, uint index, StringBuilder product);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiQueryProductStateW")] private static extern int MsiQueryProductState(string product);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiGetProductInfoW")] private static extern uint MsiGetProductInfo(string product, string property, StringBuilder value, ref uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateHardLink(string newFile, string existingFile, IntPtr securityAttributes);
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Ragent";
    private static bool quiet;
    private static string ownerSid;

    [STAThread] private static int Main(string[] args) {
        string temp = null;
        try {
            quiet = Has(args, "/quiet") || Has(args, "/q") || Has(args, "/qn") || Has(args, "/passive") || Has(args, "/qb");
            if (new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
                throw new InvalidOperationException("Run Ragent Setup without administrator elevation. Windows Installer will request approval for the service when needed.");
            ownerSid = WindowsIdentity.GetCurrent().User.Value;
            temp = Path.Combine(Path.GetTempPath(), "Ragent-setup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);
            string machine = Extract("Machine", temp), desktop = Extract("Desktop", temp);
            AddRepairAlias(machine); AddRepairAlias(desktop);
            bool uninstall = Has(args, "/uninstall") || Has(args, "/x");
            if (uninstall) {
                SetStatus("removing-service", 0);
                int b = RemoveRelated(machine, true);
                if (!Succeeded(b)) { SetStatus("service-removal-failed", b); Report("The service removal did not finish. The desktop and uninstall entry remain available; run Uninstall again to retry."); return b; }
                SetStatus("removing-desktop", 0);
                int a = RemoveRelated(desktop, false);
                if (!Succeeded(a)) { SetStatus("desktop-removal-failed", a); Report("The service was removed, but the desktop removal did not finish. Run Uninstall again to retry."); return a; }
                // Keep the ownership record for the running maintenance EXE;
                // it permits a later reinstall without treating it as foreign.
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UninstallKey, true)) {
                    if (key != null) { key.SetValue("SystemComponent", 1, RegistryValueKind.DWord); key.SetValue("SetupStatus", "removed"); }
                }
                return a == 3010 || b == 3010 ? 3010 : 0;
            }
            int user = RunInstall(desktop, args, false);
            if (!Succeeded(user)) {
                if (user != 1602) Report("The desktop installation did not finish. Run Ragent Setup again to retry.");
                return user;
            }
            RegisterSetup(machine, desktop);
            SetStatus("installing-service", 0);
            int service = RunInstall(machine, args, true);
            if (!Succeeded(service)) {
                SetStatus("service-install-failed", service);
                Report("The desktop was installed or updated, but the service installation did not finish. Run Ragent Setup again to complete or repair the installation.");
                return service;
            }
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UninstallKey, true)) {
                key.SetValue("MachineProductCode", Property(machine, "ProductCode"));
                key.SetValue("MachineProductVersion", Property(machine, "ProductVersion"));
                var version = (AssemblyInformationalVersionAttribute)Attribute.GetCustomAttribute(Assembly.GetExecutingAssembly(), typeof(AssemblyInformationalVersionAttribute));
                if (version != null) key.SetValue("DisplayVersion", version.InformationalVersion);
            }
            SetStatus("installed", 0);
            return user == 3010 || service == 3010 ? 3010 : 0;
        } catch (Exception error) { Report("Ragent Setup could not finish. Run it again to retry.\n\n" + error.Message); return 1; }
        finally { if (temp != null) try { Directory.Delete(temp, true); } catch (IOException) {} catch (UnauthorizedAccessException) {} }
    }
    private static bool Has(string[] args, string value) { foreach (string a in args) if (String.Equals(a, value, StringComparison.OrdinalIgnoreCase)) return true; return false; }
    private static bool Succeeded(int code) { return code == 0 || code == 3010; }
    private static void Report(string message) { if (!quiet) MessageBox.Show(message, "Ragent Setup", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    private static string Extract(string name, string directory) {
        Assembly assembly = Assembly.GetExecutingAssembly();
        string file = Path.Combine(directory, "Ragent." + name + ".msi"), expected;
        using (Stream input = assembly.GetManifestResourceStream("Ragent." + name + ".msi")) {
            if (input == null) throw new InvalidOperationException(name + " installer is missing.");
            using (FileStream output = new FileStream(file, FileMode.CreateNew)) input.CopyTo(output);
        }
        using (Stream input = assembly.GetManifestResourceStream("Ragent." + name + ".sha256")) {
            if (input == null) throw new InvalidOperationException(name + " checksum is missing.");
            using (StreamReader reader = new StreamReader(input, Encoding.ASCII)) expected = reader.ReadToEnd().Trim();
        }
        using (SHA256 hash = SHA256.Create()) using (FileStream input = File.OpenRead(file))
            if (!String.Equals(expected, BitConverter.ToString(hash.ComputeHash(input)).Replace("-", ""), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException(name + " installer verification failed.");
        return file;
    }
    private static string Property(string msi, string name) {
        uint db, view = 0, record = 0;
        if (MsiOpenDatabase(msi, IntPtr.Zero, out db) != 0) throw new InvalidOperationException("Cannot read installer identity.");
        try {
            if (MsiDatabaseOpenView(db, "SELECT `Value` FROM `Property` WHERE `Property` = '" + name + "'", out view) != 0 || MsiViewExecute(view, 0) != 0 || MsiViewFetch(view, out record) != 0) throw new InvalidOperationException("Installer identity is incomplete.");
            var value = new StringBuilder(256); uint length = (uint)value.Capacity;
            if (MsiRecordGetString(record, 1, value, ref length) != 0) throw new InvalidOperationException("Cannot read installer identity.");
            return value.ToString();
        } finally { if (record != 0) MsiCloseHandle(record); if (view != 0) MsiCloseHandle(view); MsiCloseHandle(db); }
    }
    private static void AddRepairAlias(string msi) {
        string product = Property(msi, "ProductCode");
        if (MsiQueryProductState(product) != 5) return;
        var value = new StringBuilder(512); uint length = (uint)value.Capacity;
        if (MsiGetProductInfo(product, "PackageName", value, ref length) != 0) return;
        string name = value.ToString();
        if (String.IsNullOrWhiteSpace(name) || name.Length > 240 || name != Path.GetFileName(name) ||
            !String.Equals(Path.GetExtension(name), ".msi", StringComparison.OrdinalIgnoreCase) || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return;
        string alias = Path.Combine(Path.GetDirectoryName(msi), name);
        if (String.Equals(alias, msi, StringComparison.OrdinalIgnoreCase)) return;
        if (File.Exists(alias)) throw new InvalidOperationException("The installer repair source names conflict.");
        if (!CreateHardLink(alias, msi, IntPtr.Zero)) File.Copy(msi, alias, false);
    }
    private static int RunInstall(string msi, string[] args, bool machine) {
        var command = new StringBuilder("/i ").Append(Quote(msi)).Append(" /norestart ARPSYSTEMCOMPONENT=1");
        if (!machine) command.Append(" RAGENT_INPLACE_UPDATE=1");
        if (MsiQueryProductState(Property(msi, "ProductCode")) == 5) command.Append(" REINSTALL=ALL REINSTALLMODE=vomus");
        if (machine) command.Append(" /passive ").Append(Quote("RAGENT_OWNER_SID=" + ownerSid));
        else foreach (string arg in args) {
            // The embedded UI supports basic UI; /passive must not wait for
            // a button during the automatic update flow.
            if (arg.Equals("/passive", StringComparison.OrdinalIgnoreCase) || arg.Equals("/qb", StringComparison.OrdinalIgnoreCase)) command.Append(" /qn");
            else if (arg.Equals("/norestart", StringComparison.OrdinalIgnoreCase) || arg.Equals("/quiet", StringComparison.OrdinalIgnoreCase) || arg.Equals("/q", StringComparison.OrdinalIgnoreCase) || arg.Equals("/qn", StringComparison.OrdinalIgnoreCase) || arg.StartsWith("DESKTOPINSTALLDIR=", StringComparison.OrdinalIgnoreCase)) command.Append(' ').Append(Quote(arg));
        }
        if (machine) return Run(command.ToString(), true);
        string cancelEventName = @"Local\Ragent.Setup.Cancel." + Guid.NewGuid().ToString("N");
        using (var cancelEvent = new EventWaitHandle(false, EventResetMode.ManualReset, cancelEventName)) {
            command.Append(' ').Append(Quote("RAGENT_CANCEL_EVENT=" + cancelEventName));
            int result = Run(command.ToString(), false);
            return result != 0 && result != 3010 && cancelEvent.WaitOne(0) ? 1602 : result;
        }
    }
    private static int RemoveRelated(string msi, bool machine) {
        var products = new List<string>(); string upgrade = Property(msi, "UpgradeCode");
        for (uint i = 0; ; i++) { var product = new StringBuilder(40); uint result = MsiEnumRelatedProducts(upgrade, 0, i, product); if (result == 259) break; if (result != 0) throw new InvalidOperationException("Cannot enumerate installed products."); if (MsiQueryProductState(product.ToString()) == 5) products.Add(product.ToString()); }
        int resultCode = 0;
        foreach (string product in products) { int result = Run("/x " + product + " /passive /norestart", machine); if (!Succeeded(result) && result != 1605) return result; if (result == 3010) resultCode = result; }
        return resultCode;
    }
    private static int Run(string command, bool elevated) {
        var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "msiexec.exe"), command);
        start.UseShellExecute = elevated; if (elevated) start.Verb = "runas";
        try { using (Process process = Process.Start(start)) { if (process == null) throw new InvalidOperationException("Windows Installer could not start."); process.WaitForExit(); return process.ExitCode; } }
        catch (System.ComponentModel.Win32Exception error) { if (error.NativeErrorCode == 1223) return 1602; throw; }
    }
    private static void RegisterSetup(string machine, string desktop) {
        string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RagentSetup");
        string source = Assembly.GetExecutingAssembly().Location, dest = Path.Combine(directory, "RagentSetup.exe");
        if (Directory.Exists(directory) && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("The setup maintenance directory is a link.");
        if (File.Exists(dest) && !String.Equals(source, dest, StringComparison.OrdinalIgnoreCase)) {
            string registered = null;
            using (RegistryKey existing = Registry.CurrentUser.OpenSubKey(UninstallKey)) if (existing != null) registered = existing.GetValue("SetupPath") as string;
            if (!String.Equals(registered, dest, StringComparison.OrdinalIgnoreCase) || (File.GetAttributes(dest) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("The setup maintenance file already belongs to another application.");
        }
        Directory.CreateDirectory(directory);
        if (!String.Equals(source, dest, StringComparison.OrdinalIgnoreCase)) File.Copy(source, dest, true);
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKey)) {
            key.SetValue("CandidateMachineProductCode", Property(machine, "ProductCode")); key.SetValue("CandidateMachineProductVersion", Property(machine, "ProductVersion"));
            key.SetValue("CandidateDesktopProductCode", Property(desktop, "ProductCode")); key.SetValue("CandidateDesktopProductVersion", Property(desktop, "ProductVersion"));
            key.SetValue("DesktopProductCode", Property(desktop, "ProductCode")); key.SetValue("DesktopProductVersion", Property(desktop, "ProductVersion"));
            key.SetValue("DisplayName", "Ragent"); key.SetValue("Publisher", "Ragent"); key.SetValue("DisplayIcon", dest);
            key.SetValue("SystemComponent", 0, RegistryValueKind.DWord);
            key.SetValue("SetupPath", dest);
            key.SetValue("UninstallString", Quote(dest) + " /uninstall"); key.SetValue("ModifyPath", Quote(dest)); key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }
    private static void SetStatus(string status, int result) {
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKey)) {
            key.SetValue("SetupStatus", status); key.SetValue("SetupResult", result, RegistryValueKind.DWord);
        }
    }
    private static string Quote(string value) {
        if (value.Length > 0 && value.IndexOfAny(new char[] {' ', '\t', '\n', '\v', '"'}) < 0) return value;
        var text = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) { if (c == '\\') { slashes++; continue; } if (c == '"') { text.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; } text.Append('\\', slashes).Append(c); slashes = 0; }
        return text.Append('\\', slashes * 2).Append('"').ToString();
    }
}
