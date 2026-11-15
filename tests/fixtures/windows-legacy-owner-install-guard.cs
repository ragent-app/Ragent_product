using System;
using System.IO;
using System.Collections.Generic;
using System.Web.Script.Serialization;
public static partial class RagentLegacyOwnerInstallGuard {
    public static int TestRun(string root) {
        var results = new List<string>();
        Action<string,Action,string> check = (name,action,expected) => {
            string code = null;try { action(); } catch(Exception error) { code = error.Message; }
            if(code != expected) throw new Exception(name+": expected "+expected+", got "+code);
            results.Add(name);
        };
        var product = Path.Combine(root,"product");var instance = Path.Combine(root,"instance");var package = Path.Combine(root,"package");
        Func<IEnumerable<KeyValuePair<string,string>>> empty = () => new KeyValuePair<string,string>[0];
        Func<string,bool> absent = path => false;
        Action<Func<string,bool>,Func<IEnumerable<KeyValuePair<string,string>>>> inspect = (present,accounts) => Guarded(() => Inspect(product,instance,package,present,accounts));
        check("empty legacy installation",()=>inspect(absent,empty),null);
        var system = new [] {new KeyValuePair<string,string>(Services[0],"LocalSystem"),new KeyValuePair<string,string>(Services[1],@"NT AUTHORITY\SYSTEM")};
        check("existing SYSTEM pair",()=>inspect(absent,()=>system),null);
        check("partial legacy SYSTEM repair",()=>inspect(absent,()=>new [] {system[0]}),null);
        foreach(var relative in new [] {"owner-policy.install-lock","security",@"runtime\owner-bootstrap-publisher.json",@"runtime\owner-bootstrap-publisher.json.publisher-lock",@"runtime\owner-bootstrap-cli-live.json",@"runtime\owner-bootstrap-cli-live.json.publisher-lock",@"runtime\owner-bootstrap-browser-live.json",@"runtime\owner-bootstrap-browser-live.json.publisher-lock"}) {
            var path=Path.Combine(instance,relative);bool queried=false;
            check("presence refuses "+relative,()=>inspect(p=>p==path,()=>{queried=true;return system;}),"OLG_OWNER_STATE_PRESENT");
            if(queried)throw new Exception("must stop before SCM query");
        }
        foreach(var path in new [] {Path.Combine(product,@"payload\owner-bootstrap-release.json"),Path.Combine(package,"owner-bootstrap-release.json"),Path.Combine(package,@"payload\owner-bootstrap-release.json")})
            check("signed state "+path,()=>inspect(p=>p==path,empty),"OLG_SIGNED_INSTALLER_REQUIRED");
        foreach(var name in Services)foreach(var account in new [] {@"NT SERVICE\Ragent-ControlPlane",@"NT SERVICE\Ragent-RunnerSupervisor",@"DESKTOP\Owner","NetworkService","",null})
            check("non-SYSTEM "+name+":"+account,()=>inspect(absent,()=>new [] {new KeyValuePair<string,string>(name,account)}),"OLG_SERVICE_IDENTITY_MANAGED");
        check("duplicate SCM rows",()=>inspect(absent,()=>new [] {system[0],system[0]}),"OLG_SERVICE_STATE_INVALID");
        check("unexpected service",()=>inspect(absent,()=>new [] {new KeyValuePair<string,string>("foreign","LocalSystem")}),"OLG_SERVICE_STATE_INVALID");
        check("path read denied",()=>inspect(p=>{throw new UnauthorizedAccessException("private detail");},empty),"OLG_INSPECTION_FAILED");
        check("path IO unknown",()=>inspect(p=>{throw new IOException("private detail");},empty),"OLG_INSPECTION_FAILED");
        check("SCM read denied",()=>inspect(absent,()=>{throw new UnauthorizedAccessException("private detail");}),"OLG_INSPECTION_FAILED");
        check("SCM unknown",()=>inspect(absent,()=>{throw new InvalidOperationException("private detail");}),"OLG_INSPECTION_FAILED");
        Directory.CreateDirectory(instance);Directory.CreateDirectory(package);Directory.CreateDirectory(product);
        check("actual missing NTFS state",()=>inspect(Present,empty),null);
        var serviceLock=Path.Combine(product,"owner-services.prepare-lock");File.WriteAllText(serviceLock,"invalid non-JSON");
        check("actual retained service preparation",()=>inspect(Present,empty),"OLG_OWNER_STATE_PRESENT");File.Delete(serviceLock);
        Directory.CreateDirectory(serviceLock);check("actual service preparation lock directory",()=>inspect(Present,empty),"OLG_OWNER_STATE_PRESENT");Directory.Delete(serviceLock);
        var dataLock=Path.Combine(product,"owner-data.prepare-lock");File.WriteAllText(dataLock,"invalid non-JSON");
        check("actual retained data preparation",()=>inspect(Present,empty),"OLG_OWNER_STATE_PRESENT");File.Delete(dataLock);
        Directory.CreateDirectory(dataLock);check("actual data preparation lock directory",()=>inspect(Present,empty),"OLG_OWNER_STATE_PRESENT");Directory.Delete(dataLock);
        foreach(var name in new[]{"owner-msi.prepare-lock","owner-msi.prepared.json","owner-identity.initialize-lock","owner-activation.prepare-lock","owner-policy.prepare-lock","owner-msi.policy.json"}){
            var path=Path.Combine(product,name);File.WriteAllText(path,"invalid non-JSON");check("actual MSI state file "+name,()=>inspect(Present,empty),"OLG_OWNER_STATE_PRESENT");File.Delete(path);
            Directory.CreateDirectory(path);check("actual MSI state directory "+name,()=>inspect(Present,empty),"OLG_OWNER_STATE_PRESENT");Directory.Delete(path);
        }
        var lockPath=Path.Combine(instance,"owner-policy.install-lock");File.WriteAllText(lockPath,"invalid non-JSON");
        check("actual corrupt lock",()=>inspect(Present,empty),"OLG_OWNER_STATE_PRESENT");File.Delete(lockPath);
        Directory.CreateDirectory(lockPath);check("actual lock directory",()=>inspect(Present,empty),"OLG_OWNER_STATE_PRESENT");Directory.Delete(lockPath);
        Directory.CreateDirectory(Path.Combine(instance,"security"));check("actual empty security quarantine",()=>inspect(Present,empty),"OLG_OWNER_STATE_PRESENT");Directory.Delete(Path.Combine(instance,"security"));
        var releasePath=Path.Combine(package,"owner-bootstrap-release.json");File.WriteAllText(releasePath,"invalid non-JSON");
        check("actual corrupt package metadata",()=>inspect(Present,empty),"OLG_SIGNED_INSTALLER_REQUIRED");File.Delete(releasePath);
        var bad=Path.Combine(root,"not-a-directory");File.WriteAllText(bad,"x");
        check("actual file ancestor",()=>Guarded(()=>Present(Path.Combine(bad,"missing"))),"OLG_PATH_UNSAFE");
        check("actual junction ancestor",()=>Guarded(()=>Present(Path.Combine(root,"junction","missing"))),"OLG_PATH_UNSAFE");
        check("actual dangling junction",()=>Guarded(()=>Present(Path.Combine(root,"dangling","missing"))),"OLG_PATH_UNSAFE");
        Console.WriteLine(new JavaScriptSerializer().Serialize(new {pass=true,checks=results}));return 0;
    }
}
public static class LegacyOwnerGuardTests { public static int Main(string[] args) { return RagentLegacyOwnerInstallGuard.TestRun(args[0]); } }
