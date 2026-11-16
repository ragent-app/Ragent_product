using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;
using System.Windows.Forms;
using System.Security.Principal;

internal static class DesktopGuard {
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int informationClass, out int information, int informationLength, out int returnLength);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiGetProductInfo(string product, string property, StringBuilder value, ref uint length);
    static string Full(string p) { return Path.GetFullPath(p).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar); }
    static bool Within(string path, string root) { return path.Equals(root, StringComparison.OrdinalIgnoreCase) || path.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase); }
    static bool IsCurrentUser(Process process) {
        IntPtr token;
        if (!OpenProcessToken(process.Handle, 8, out token)) return false;
        try { using (var owner = new WindowsIdentity(token)) using (var current = WindowsIdentity.GetCurrent()) return owner.User.Equals(current.User); }
        finally { CloseHandle(token); }
    }
    static void CheckReparse(string path) {
        for (string p = path; !String.IsNullOrEmpty(p); p = Path.GetDirectoryName(p)) {
            if ((Directory.Exists(p) || File.Exists(p)) && (File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("The installation path contains a link or junction.");
            string parent = Path.GetDirectoryName(p); if (parent == p) break;
        }
    }
    static string LongName(string value) {
        string target = value.Split(':')[0]; int separator = target.IndexOf('|');
        return separator < 0 ? target : target.Substring(separator + 1);
    }
    static HashSet<string> OwnedFiles(string product, string root) {
        var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        uint length = 32768; var package = new StringBuilder((int)length);
        if (MsiGetProductInfo(product, "LocalPackage", package, ref length) != 0 || !File.Exists(package.ToString())) throw new InvalidOperationException("Cannot read the installed desktop package.");
        var directories = new Dictionary<string, Tuple<string,string>>(StringComparer.Ordinal);
        dynamic installer = Activator.CreateInstance(Type.GetTypeFromProgID("WindowsInstaller.Installer"));
        dynamic database = installer.OpenDatabase(package.ToString(), 0);
        dynamic view = database.OpenView("SELECT `Directory`, `Directory_Parent`, `DefaultDir` FROM `Directory`");
        view.Execute(); dynamic row;
        while ((row = view.Fetch()) != null) directories[(string)row.StringData[1]] = Tuple.Create((string)row.StringData[2], LongName((string)row.StringData[3]));
        view.Close();
        view = database.OpenView("SELECT `File`.`FileName`, `Component`.`Directory_` FROM `File`, `Component` WHERE `File`.`Component_` = `Component`.`Component`");
        view.Execute();
        while ((row = view.Fetch()) != null) {
            string name = LongName((string)row.StringData[1]), id = (string)row.StringData[2];
            var parts = new List<string>(); var visited = new HashSet<string>(StringComparer.Ordinal);
            while (id != "DESKTOPINSTALLDIR") {
                Tuple<string,string> directory;
                if (!visited.Add(id) || !directories.TryGetValue(id, out directory)) throw new InvalidOperationException("Cannot verify the installed desktop directory.");
                if (String.IsNullOrEmpty(directory.Item1)) { parts.Clear(); break; }
                if (directory.Item2 != ".") parts.Add(directory.Item2);
                id = directory.Item1;
            }
            if (id != "DESKTOPINSTALLDIR") continue;
            string path = root;
            for (int i = parts.Count - 1; i >= 0; i--) path = Path.Combine(path, parts[i]);
            path = Full(Path.Combine(path, name));
            if (!Within(path, root)) throw new InvalidOperationException("Invalid installed desktop file path.");
            files.Add(path);
        }
        view.Close();
        return files;
    }
    static void Run(string target, bool installed, bool removing) {
        int elevated, length;
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
            if (!GetTokenInformation(identity.Token, 20, out elevated, sizeof(int), out length) || elevated != 0) throw new InvalidOperationException("Run the desktop installer without administrator elevation.");
        }
        if (String.IsNullOrWhiteSpace(target) || !Path.IsPathRooted(target) || target.StartsWith("\\\\")) throw new InvalidOperationException("Choose a local installation folder.");
        string path = Full(target), root = Full(Path.GetPathRoot(path));
        if (path.Equals(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("A drive root cannot be used as an installation folder.");
        string setupRoot = Full(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RagentSetup"));
        if (Within(path, setupRoot) || Within(setupRoot, path)) throw new InvalidOperationException("Choose a folder that does not overlap the Ragent setup maintenance folder.");
        foreach (Environment.SpecialFolder f in new [] { Environment.SpecialFolder.Windows, Environment.SpecialFolder.System, Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.CommonApplicationData }) {
            string special = Environment.GetFolderPath(f); if (!String.IsNullOrEmpty(special) && Within(path, Full(special))) throw new InvalidOperationException("A protected system folder cannot be used.");
        }
        CheckReparse(path);
        string executable = Path.Combine(path, "Ragent.exe");
        foreach (Process p in Process.GetProcessesByName("Ragent")) using (p) {
            try { if (IsCurrentUser(p) && String.Equals(Full(p.MainModule.FileName), executable, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Close Ragent before installing, repairing, or removing it."); }
            catch (System.ComponentModel.Win32Exception) { } catch (NotSupportedException) { }
        }
        string oldPath = null, product = null;
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Ragent\DesktopInstaller")) if (key != null) { oldPath = key.GetValue("InstallLocation") as string; product = key.GetValue("ProductCode") as string; }
        if (!String.IsNullOrEmpty(oldPath) && !String.Equals(path, Full(oldPath), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("An existing installation must be upgraded in its original folder.");
        bool upgrade = !String.IsNullOrEmpty(oldPath) && !String.IsNullOrEmpty(product);
        if (!upgrade && Directory.Exists(path) && Directory.EnumerateFileSystemEntries(path).GetEnumerator().MoveNext()) throw new InvalidOperationException("Choose an empty installation folder.");
        if (removing) return;
        if (installed && !upgrade) throw new InvalidOperationException("Cannot verify the installed desktop location.");
        if (!upgrade) return;
        HashSet<string> owned = OwnedFiles(product, path);
        if (owned.Count == 0) throw new InvalidOperationException("Cannot verify ownership of the existing installation.");
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("DesktopPayloadPaths")) using (var reader = new StreamReader(stream, Encoding.UTF8)) {
            string relative; while ((relative = reader.ReadLine()) != null) {
                string file = Full(Path.Combine(path, relative));
                if (!Within(file, path)) throw new InvalidOperationException("Invalid desktop payload path.");
                CheckReparse(file);
                if ((File.Exists(file) || Directory.Exists(file)) && !owned.Contains(file)) throw new InvalidOperationException("The installation would overwrite an unrelated file: " + file);
            }
        }
    }
    [STAThread] static int Main(string[] args) {
        try { if (args.Length != 4) throw new InvalidOperationException("The installation folder is missing."); Run(args[0], args[1].Length != 0, args[2] == "ALL"); return 0; }
        catch (Exception ex) { int ui; if (args.Length < 4 || !Int32.TryParse(args[3], out ui) || (ui & 7) >= 5) MessageBox.Show(ex.Message, "Ragent Desktop", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
    }
}
