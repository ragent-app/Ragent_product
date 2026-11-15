using System;
using System.Diagnostics;
using System.IO;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

internal static class RagentSetup {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateHardLink(string newFileName, string existingFileName, IntPtr securityAttributes);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiOpenDatabaseW")]
    private static extern uint MsiOpenDatabase(string path, IntPtr persist, out uint database);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiDatabaseOpenViewW")]
    private static extern uint MsiDatabaseOpenView(uint database, string query, out uint view);
    [DllImport("msi.dll")] private static extern uint MsiViewExecute(uint view, uint record);
    [DllImport("msi.dll")] private static extern uint MsiViewFetch(uint view, out uint record);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiRecordGetStringW")]
    private static extern uint MsiRecordGetString(uint record, uint field, StringBuilder value, ref uint length);
    [DllImport("msi.dll")] private static extern uint MsiCloseHandle(uint handle);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiEnumRelatedProductsW")]
    private static extern uint MsiEnumRelatedProducts(string upgradeCode, uint reserved, uint index, StringBuilder product);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiQueryProductStateW")]
    private static extern int MsiQueryProductState(string product);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiGetProductInfoW")]
    private static extern uint MsiGetProductInfo(string product, string property, StringBuilder value, ref uint length);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiGetComponentPathW")]
    private static extern int MsiGetComponentPath(string product, string component, StringBuilder path, ref uint length);
    private const string PayloadResource = "Ragent.Payload.msi";
    private const string HashResource = "Ragent.Payload.sha256";

    [STAThread]
    private static int Main(string[] args) {
        string directory = null;
        string payloadPath = null;
        var repairSourcePaths = new List<string>();
        try {
            directory = Path.Combine(Path.GetTempPath(), "Ragent-setup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            payloadPath = Path.Combine(directory, "Ragent.msi");
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream input = assembly.GetManifestResourceStream(PayloadResource)) {
                if (input == null) throw new InvalidOperationException("Installer payload is missing.");
                using (FileStream output = new FileStream(payloadPath, FileMode.CreateNew, FileAccess.Write, FileShare.None)) input.CopyTo(output);
            }
            string expected;
            using (Stream input = assembly.GetManifestResourceStream(HashResource)) {
                if (input == null) throw new InvalidOperationException("Installer checksum is missing.");
                using (StreamReader reader = new StreamReader(input, Encoding.ASCII)) expected = reader.ReadToEnd().Trim();
            }
            string actual;
            using (SHA256 hash = SHA256.Create())
            using (FileStream input = File.OpenRead(payloadPath)) actual = BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "");
            if (!String.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Installer payload verification failed.");

            // Secure Repair resolves the package name registered by the first
            // install. That name can differ between MSI and EXE distributions.
            var aliases = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            aliases.Add("Ragent-0.0.1.msi");
            string registeredPackageName = GetRegisteredPackageName(payloadPath);
            if (!String.IsNullOrEmpty(registeredPackageName)) aliases.Add(registeredPackageName);
            foreach (string alias in aliases) {
                string aliasPath = Path.Combine(directory, alias);
                if (String.Equals(aliasPath, payloadPath, StringComparison.OrdinalIgnoreCase)) continue;
                if (!CreateHardLink(aliasPath, payloadPath, IntPtr.Zero)) File.Copy(payloadPath, aliasPath, false);
                repairSourcePaths.Add(aliasPath);
            }

            string command = BuildMsiCommand(payloadPath, args);
            ProcessStartInfo start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "msiexec.exe"), command.ToString());
            start.UseShellExecute = false;
            using (Process process = Process.Start(start)) {
                if (process == null) throw new InvalidOperationException("Windows Installer could not be started.");
                process.WaitForExit();
                return process.ExitCode;
            }
        } catch (Exception error) {
            MessageBox.Show("Ragent setup could not start.\n\n" + error.Message, "Ragent Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        } finally {
            foreach (string repairSourcePath in repairSourcePaths) {
                try { if (File.Exists(repairSourcePath)) File.Delete(repairSourcePath); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
            try { if (payloadPath != null && File.Exists(payloadPath)) File.Delete(payloadPath); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            try { if (directory != null && Directory.Exists(directory)) Directory.Delete(directory, false); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    private static bool IsQuiet(string[] args) {
        foreach (string arg in args) {
            string value = arg.ToLowerInvariant();
            if (value == "/q" || value == "/quiet" || value == "/passive" || value.StartsWith("/qn", StringComparison.Ordinal) || value.StartsWith("/qb", StringComparison.Ordinal)) return true;
        }
        return false;
    }

    private static bool HasInstallFolder(string[] args) {
        foreach (string arg in args)
            if (arg.StartsWith("RAGENT_INSTALLFOLDER=", StringComparison.OrdinalIgnoreCase) || arg.StartsWith("INSTALLFOLDER=", StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static bool HasMsiProperty(string[] args, string name) {
        string prefix = name + "=";
        foreach (string arg in args)
            if (arg.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static bool IsExactProductInstalled(string msi) {
        uint database;
        if (MsiOpenDatabase(msi, IntPtr.Zero, out database) != 0)
            throw new InvalidOperationException("Installer product identity could not be read.");
        try {
            string productCode = ReadMsiValue(database, "SELECT `Value` FROM `Property` WHERE `Property` = 'ProductCode'");
            if (String.IsNullOrEmpty(productCode))
                throw new InvalidOperationException("Installer product code is missing.");
            return MsiQueryProductState(productCode) == 5;
        } finally { MsiCloseHandle(database); }
    }

    private static string GetRegisteredPackageName(string msi) {
        uint database;
        if (MsiOpenDatabase(msi, IntPtr.Zero, out database) != 0)
            throw new InvalidOperationException("Installer product identity could not be read.");
        string productCode;
        try { productCode = ReadMsiValue(database, "SELECT `Value` FROM `Property` WHERE `Property` = 'ProductCode'"); }
        finally { MsiCloseHandle(database); }
        if (String.IsNullOrEmpty(productCode) || MsiQueryProductState(productCode) != 5) return null;
        var value = new StringBuilder(512); uint length = (uint)value.Capacity;
        if (MsiGetProductInfo(productCode, "PackageName", value, ref length) != 0) return null;
        string name = value.ToString();
        if (String.IsNullOrWhiteSpace(name) || name.Length > 240 ||
            !String.Equals(Path.GetFileName(name), name, StringComparison.Ordinal) ||
            !String.Equals(Path.GetExtension(name), ".msi", StringComparison.OrdinalIgnoreCase) ||
            name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return null;
        return name;
    }

    private static string BuildMsiCommand(string payloadPath, string[] args) {
        StringBuilder command = new StringBuilder("/i ").Append(Quote(payloadPath));
        // A same-ProductCode minor update needs both properties or Windows
        // Installer rejects it as an older product. Detect only this exact
        // product so another installed product cannot enter the minor lane.
        if (IsExactProductInstalled(payloadPath)) {
            if (!HasMsiProperty(args, "REINSTALL")) command.Append(" REINSTALL=ALL");
            if (!HasMsiProperty(args, "REINSTALLMODE")) command.Append(" REINSTALLMODE=vomus");
        }
        // Embedded UI discovers the previous installation interactively. MSI
        // does not load it in quiet mode, so resolve its registered location.
        // The installer's admission checks still validate the resulting path.
        string existingFolder;
        if (IsQuiet(args) && !HasInstallFolder(args) && TryFindInstalledFolder(payloadPath, out existingFolder))
            command.Append(' ').Append(Quote("RAGENT_INSTALLFOLDER=" + existingFolder));
        foreach (string arg in args) command.Append(' ').Append(Quote(arg));
        return command.ToString();
    }

    private static string ReadMsiValue(uint database, string query) {
        uint view = 0, record = 0;
        try {
            if (MsiDatabaseOpenView(database, query, out view) != 0 || MsiViewExecute(view, 0) != 0 || MsiViewFetch(view, out record) != 0) return null;
            var value = new StringBuilder(256); uint length = (uint)value.Capacity;
            return MsiRecordGetString(record, 1, value, ref length) == 0 ? value.ToString() : null;
        } finally { if (record != 0) MsiCloseHandle(record); if (view != 0) MsiCloseHandle(view); }
    }

    private static bool TryFindInstalledFolder(string msi, out string folder) {
        folder = null; uint database;
        if (MsiOpenDatabase(msi, IntPtr.Zero, out database) != 0) return false;
        string upgradeCode, component;
        try {
            upgradeCode = ReadMsiValue(database, "SELECT `Value` FROM `Property` WHERE `Property` = 'UpgradeCode'");
            component = ReadMsiValue(database, "SELECT `ComponentId` FROM `Component` WHERE `Component` = 'ManagedServiceHost'");
        } finally { MsiCloseHandle(database); }
        if (String.IsNullOrEmpty(upgradeCode) || String.IsNullOrEmpty(component)) return false;
        var installed = new List<string>();
        for (uint i = 0; ; i++) {
            var product = new StringBuilder(40); uint result = MsiEnumRelatedProducts(upgradeCode, 0, i, product);
            if (result == 259) break; // ERROR_NO_MORE_ITEMS
            if (result != 0) return false;
            if (MsiQueryProductState(product.ToString()) == 5) installed.Add(product.ToString());
        }
        if (installed.Count != 1) return false;
        var service = new StringBuilder(32768); uint length = (uint)service.Capacity;
        if (MsiGetComponentPath(installed[0], component, service, ref length) != 3) return false; // INSTALLSTATE_LOCAL
        string servicePath = service.ToString();
        if (!Path.IsPathRooted(servicePath) || !String.Equals(Path.GetFileName(servicePath), "Ragent.ServiceHost.exe", StringComparison.OrdinalIgnoreCase)) return false;
        folder = Path.GetDirectoryName(servicePath);
        return !String.IsNullOrEmpty(folder);
    }

    // Windows command line escaping for CommandLineToArgvW / MSI arguments.
    private static string Quote(string value) {
        // msiexec parses switches itself and does not accept quoted switches.
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        StringBuilder text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { text.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
            text.Append('\\', slashes).Append(c);
            slashes = 0;
        }
        text.Append('\\', slashes * 2).Append('"');
        return text.ToString();
    }
}
