// Read-only guard for the legacy LocalSystem installer. This never authorizes
// identity migration and deliberately refuses incomplete or ambiguous state.
using System;
using System.IO;
using System.Management;
using System.Collections.Generic;

public static partial class RagentLegacyOwnerInstallGuard {
    static readonly string Product = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Ragent");
    static readonly string Instance = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), @"Ragent\instances\owner");
    static readonly string[] Services = { "Ragent-ControlPlane", "Ragent-RunnerSupervisor" };
    static void Refuse(string code) { throw new InvalidOperationException(code); }

    // GetAttributes distinguishes absence from access/IO failures and includes
    // directories and dangling reparse points. Exists/Test-Path would hide errors.
    static bool Present(string path) {
        var chain = new List<string>();
        for (var p = Path.GetFullPath(path); p != null; p = Path.GetDirectoryName(p)) chain.Add(p);
        chain.Reverse();
        foreach (var p in chain) {
            FileAttributes attributes;
            try { attributes = File.GetAttributes(p); }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) { return false; }
            if ((attributes & FileAttributes.ReparsePoint) != 0) Refuse("OLG_PATH_UNSAFE");
            if (!String.Equals(p,chain[chain.Count-1],StringComparison.OrdinalIgnoreCase) && (attributes & FileAttributes.Directory) == 0)
                Refuse("OLG_PATH_UNSAFE");
        }
        return true;
    }
    static IEnumerable<KeyValuePair<string,string>> Accounts() {
        var options = new EnumerationOptions { Timeout = TimeSpan.FromSeconds(5), ReturnImmediately = false };
        using (var search = new ManagementObjectSearcher(new ManagementScope(@"\\.\root\cimv2"),
            new ObjectQuery("SELECT Name,StartName FROM Win32_Service WHERE Name='Ragent-ControlPlane' OR Name='Ragent-RunnerSupervisor'"), options))
        using (var rows = search.Get()) {
            foreach (ManagementObject row in rows) {
                using (row) yield return new KeyValuePair<string,string>(row["Name"] as string, row["StartName"] as string);
            }
        }
    }
    static void Inspect(string product, string instance, string package, Func<string,bool> present,
        Func<IEnumerable<KeyValuePair<string,string>>> accounts) {
        // Any presence suffices; never parse/recover policy, locks or credentials.
        if (present(Path.Combine(product,"owner-services.prepare-lock"))) Refuse("OLG_OWNER_STATE_PRESENT");
        if (present(Path.Combine(product,"owner-data.prepare-lock"))) Refuse("OLG_OWNER_STATE_PRESENT");
        if (present(Path.Combine(product,"owner-msi.prepare-lock"))) Refuse("OLG_OWNER_STATE_PRESENT");
        if (present(Path.Combine(product,"owner-identity.initialize-lock"))) Refuse("OLG_OWNER_STATE_PRESENT");
        if (present(Path.Combine(product,"owner-msi.prepared.json"))) Refuse("OLG_OWNER_STATE_PRESENT");
        if (present(Path.Combine(product,"owner-activation.prepare-lock"))) Refuse("OLG_OWNER_STATE_PRESENT");
        if (present(Path.Combine(product,"owner-policy.prepare-lock"))) Refuse("OLG_OWNER_STATE_PRESENT");
        if (present(Path.Combine(product,"owner-msi.policy.json"))) Refuse("OLG_OWNER_STATE_PRESENT");
        foreach (var relative in new [] { "owner-policy.install-lock", @"security", @"runtime\owner-bootstrap-publisher.json",
            @"runtime\owner-bootstrap-publisher.json.publisher-lock", @"runtime\owner-bootstrap-cli-live.json",
            @"runtime\owner-bootstrap-cli-live.json.publisher-lock", @"runtime\owner-bootstrap-browser-live.json",
            @"runtime\owner-bootstrap-browser-live.json.publisher-lock" })
            if (present(Path.Combine(instance,relative))) Refuse("OLG_OWNER_STATE_PRESENT");
        if (present(Path.Combine(product,@"payload\owner-bootstrap-release.json"))) Refuse("OLG_SIGNED_INSTALLER_REQUIRED");
        if (!String.IsNullOrEmpty(package)) {
            foreach (var relative in new [] { "owner-bootstrap-release.json", @"payload\owner-bootstrap-release.json" })
                if (present(Path.Combine(package,relative))) Refuse("OLG_SIGNED_INSTALLER_REQUIRED");
        }
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var row in accounts()) {
            if (Array.FindIndex(Services,s => String.Equals(s,row.Key,StringComparison.OrdinalIgnoreCase)) < 0 || !seen.Add(row.Key))
                Refuse("OLG_SERVICE_STATE_INVALID");
            if (!String.Equals(row.Value,"LocalSystem",StringComparison.OrdinalIgnoreCase) &&
                !String.Equals(row.Value,@"NT AUTHORITY\SYSTEM",StringComparison.OrdinalIgnoreCase)) Refuse("OLG_SERVICE_IDENTITY_MANAGED");
        }
    }
    static void Guarded(Action inspection) {
        try {
            inspection();
        } catch (InvalidOperationException error) {
            if (error.Message.StartsWith("OLG_",StringComparison.Ordinal)) throw;
            Refuse("OLG_INSPECTION_FAILED");
        } catch { Refuse("OLG_INSPECTION_FAILED"); }
    }
    public static void AssertCompatible(string packageRoot) {
        Guarded(() => {
            // The old script used environment-selected roots; do not inspect C:
            // and subsequently mutate an alternate tree chosen by its caller.
            if (!String.Equals(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"Ragent"),Product,StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),@"Ragent\instances\owner"),Instance,StringComparison.OrdinalIgnoreCase))
                Refuse("OLG_ROOT_UNSUPPORTED");
            Inspect(Product,Instance,packageRoot,Present,Accounts);
        });
    }
    public static int Main(string[] args) {
        try {
            if (args.Length != 0) Refuse("OLG_ARGUMENTS_REFUSED");
            AssertCompatible(null);
            Console.WriteLine("OLG_LEGACY_COMPATIBLE");return 0;
        } catch (Exception error) {
            Console.Error.WriteLine(error.Message.StartsWith("OLG_",StringComparison.Ordinal) ? error.Message : "OLG_INSPECTION_FAILED");return 1;
        }
    }
}
