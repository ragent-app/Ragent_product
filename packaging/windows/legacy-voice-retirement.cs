// Transactional retirement of the exact Ragent-managed Whisper release.
// The caller queues Rollback before Prepare and Commit after a successful upgrade.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using AgentoC.ServiceHost;

internal static class LegacyVoiceRetirement {
 internal sealed class Entry { public string name {get;set;} public string sha256 {get;set;} }
 internal sealed class Journal { public int version {get;set;} public Entry[] files {get;set;} }
 static readonly Dictionary<string,string> Known = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase) {
  {"whisper-server.exe","a97456e747f28e7bb09c1dac35f40d94404c5ecffa74aaaaa7a3753ea6543121"},
  {"whisper.dll","034396d75bb5720c1851674ff64a96192b58f6927b68d334ebd254ce6cad9674"},
  {"ggml.dll","31fe18616d872af9b6134b47a6dff8072ae4ecbe5df0273f4f8dc36766c9db8e"},
  {"ggml-base.dll","bede0d6b2d387236ecd2b5dd676d51c8984b5b6e0ae461a12174e9c01345c5f0"},
  {"ggml-cpu-alderlake.dll","d8f5c56ea490394eeae8b271650f2647aecd039a542d6df9e0140726e62a4603"},
  {"ggml-cpu-cannonlake.dll","74127b40abd4f595d9db6af0fa313a02e18ff42fc228bfa05281e7c788dd4507"},
  {"ggml-cpu-cascadelake.dll","4b11c427b844eeac87529af9a8d94b35aad2024666beb2a35e59fe3077e4b81e"},
  {"ggml-cpu-haswell.dll","1306b1014c8118d27234d8ddc0e66ced1f8c8476bf85071595fd182ea9b7263b"},
  {"ggml-cpu-icelake.dll","2b4dc4c66e7d8fe2807283816e9cf3b7f7d0556f59df34069871e37eab8aed40"},
  {"ggml-cpu-sandybridge.dll","04edbdebc01a1d421062a960881a4f34d520d99693999518243f332406444c6e"},
  {"ggml-cpu-skylakex.dll","1774714cf93621406ff35344b54715619a83242ae3e331e44d98a3b35ce801be"},
  {"ggml-cpu-sse42.dll","f060318772c4c2dbac312bbfff6ea700b85dbc502bb38585a7186d06d549301a"},
  {"ggml-cpu-x64.dll","4b4b05caba40d4309b5d710ef74c59ba190516b8489f27bdb1ba11ae33c6e9d3"},
  {"ggml-base-q5_1.bin","422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898"},
  {"whisper.cpp-MIT.txt","94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d"},
  {"OpenAI-Whisper-MIT.txt","b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d"}
 };
 const string Manifest="runtime-manifest.json", JournalName="retirement-journal.json";
#if VOICE_RETIRE_TEST
 internal static void SetKnownForTest(string name,string hash){Known.Clear();Known.Add(name,hash);}
 internal static void AddKnownForTest(string name,string hash){Known.Add(name,hash);}
#endif
 static void Need(bool ok,string code){if(!ok)throw new InvalidOperationException(code);}
 static string Digest(Stream file){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(file)).Replace("-","").ToLowerInvariant();}
 static string HashFile(string path){using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){ServiceDirectoryPin.VerifyFile(file.SafeFileHandle,path);return Digest(file);}}
 static bool Inside(string root,string path){return path.StartsWith(root.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase);}
 static string Stage(string runtime){return Path.Combine(Path.GetDirectoryName(runtime),".agentoc-retired-whisper");}
 static string Sid(){return new NTAccount("NT SERVICE","AgentoC-ControlPlane").Translate(typeof(SecurityIdentifier)).Value;}
 static void SafeAcl(string path,string serviceSid,bool directory){
  FileSystemSecurity acl=directory?(FileSystemSecurity)Directory.GetAccessControl(path):File.GetAccessControl(path);
  var trusted=new HashSet<string>(new[]{"S-1-5-18","S-1-5-32-544",serviceSid});
  Need(trusted.Contains(acl.GetOwner(typeof(SecurityIdentifier)).Value),"VOICE_RETIRE_OWNER_REFUSED");
  foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))
   if(rule.AccessControlType==AccessControlType.Allow&&(rule.PropagationFlags&PropagationFlags.InheritOnly)==0&&!trusted.Contains(rule.IdentityReference.Value))
    Need(((long)rule.FileSystemRights&0x500d0156L)==0,"VOICE_RETIRE_ACL_REFUSED");
 }
 static List<IDisposable> Pin(string productRoot,string dataRoot,string runtime,bool needRuntime){
  productRoot=Path.GetFullPath(productRoot).TrimEnd('\\');dataRoot=Path.GetFullPath(dataRoot).TrimEnd('\\');runtime=Path.GetFullPath(runtime).TrimEnd('\\');
  Need(Path.IsPathRooted(runtime)&&!runtime.StartsWith(@"\\",StringComparison.Ordinal)&&String.Equals(Path.GetFileName(runtime),"voice-runtime",StringComparison.OrdinalIgnoreCase),"VOICE_RETIRE_PATH_REFUSED");
  string root=Inside(productRoot,runtime)?productRoot:Inside(dataRoot,runtime)?dataRoot:null;
  Need(root!=null,"VOICE_RETIRE_PATH_REFUSED");
  string sid=Sid();var chain=new Stack<string>();for(string p=runtime;p!=null;p=Path.GetDirectoryName(p))chain.Push(p);
  var pins=new List<IDisposable>();try{
   while(chain.Count>0){string p=chain.Pop();if(!Directory.Exists(p)){Need(!needRuntime&&String.Equals(p,runtime,StringComparison.OrdinalIgnoreCase),"VOICE_RETIRE_DIRECTORY_MISSING");break;}
    pins.Add(ServiceDirectoryPin.Directory(p));if(String.Equals(p,root,StringComparison.OrdinalIgnoreCase)||Inside(root,p))SafeAcl(p,sid,true);
   }
   return pins;
  }catch{foreach(var pin in pins)pin.Dispose();throw;}
 }
 static bool ValidManifest(string path){
  using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){
   ServiceDirectoryPin.VerifyFile(file.SafeFileHandle,path);Need(file.Length>0&&file.Length<=32768,"VOICE_RETIRE_MANIFEST_INVALID");
   string value;using(var reader=new StreamReader(file,new UTF8Encoding(false,true)))value=reader.ReadToEnd();
   var obj=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(value);
   return obj!=null&&obj.ContainsKey("schemaVersion")&&Convert.ToInt32(obj["schemaVersion"])==1
    &&obj.ContainsKey("whisperCppRelease")&&Convert.ToString(obj["whisperCppRelease"])=="b5454 (v1.9.5)"
    &&obj.ContainsKey("modelRepository")&&Convert.ToString(obj["modelRepository"])=="ggerganov/whisper.cpp"
    &&obj.ContainsKey("modelRevision")&&Convert.ToString(obj["modelRevision"])=="f281eb45af861ab5e5297d23694b7d46e090c02c";
  }
 }
 static Journal ReadJournal(string stage){
  string path=Path.Combine(stage,JournalName);SafeAcl(path,Sid(),false);
  using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){
   ServiceDirectoryPin.VerifyFile(file.SafeFileHandle,path);Need(file.Length>0&&file.Length<=32768,"VOICE_RETIRE_JOURNAL_INVALID");
   string text;using(var reader=new StreamReader(file,new UTF8Encoding(false,true)))text=reader.ReadToEnd();
   var result=new JavaScriptSerializer().Deserialize<Journal>(text);Need(result!=null&&result.version==1&&result.files!=null&&result.files.Length<=Known.Count+1,"VOICE_RETIRE_JOURNAL_INVALID");
   var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
   foreach(var entry in result.files){string known;Need(entry!=null&&entry.name!=null&&entry.sha256!=null&&seen.Add(entry.name),"VOICE_RETIRE_JOURNAL_INVALID");
    if(String.Equals(entry.name,Manifest,StringComparison.OrdinalIgnoreCase))Need(entry.sha256.Length==64&&entry.sha256.All(c=>"0123456789abcdef".Contains(c)),"VOICE_RETIRE_JOURNAL_INVALID");
    else Need(Known.TryGetValue(entry.name,out known)&&known==entry.sha256,"VOICE_RETIRE_JOURNAL_INVALID");}
   return result;
  }
 }
 internal static void Prepare(string productRoot,string dataRoot,string runtime){
  if(!Directory.Exists(runtime))return;
  var pins=Pin(productRoot,dataRoot,runtime,true);try{
   string manifest=Path.Combine(runtime,Manifest);if(!File.Exists(manifest))return;
   SafeAcl(manifest,Sid(),false);
   bool valid;try{valid=ValidManifest(manifest);}catch(ArgumentException){return;}catch(InvalidOperationException){return;}catch(System.FormatException){return;}
   if(!valid)return;
   string stage=Stage(runtime);Need(!Directory.Exists(stage)&&!File.Exists(stage),"VOICE_RETIRE_PENDING");
   var files=new List<Entry>();foreach(var pair in Known){string path=Path.Combine(runtime,pair.Key);if(!File.Exists(path))continue;SafeAcl(path,Sid(),false);if(HashFile(path)==pair.Value)files.Add(new Entry{name=pair.Key,sha256=pair.Value});}
   files.Add(new Entry{name=Manifest,sha256=HashFile(manifest)});
   Directory.CreateDirectory(stage);pins.Add(ServiceDirectoryPin.Directory(stage));SafeAcl(stage,Sid(),true);
   string journal=Path.Combine(stage,JournalName);byte[] bytes=new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(new Journal{version=1,files=files.ToArray()}));
   using(var file=new FileStream(journal,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){file.Write(bytes,0,bytes.Length);file.Flush(true);}
   foreach(var entry in files){string source=Path.Combine(runtime,entry.name);Need(HashFile(source)==entry.sha256,"VOICE_RETIRE_FILE_CHANGED");File.Move(source,Path.Combine(stage,entry.name));}
  }finally{for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();}
 }
 internal static void Finish(string productRoot,string dataRoot,string runtime,bool rollback){
  string stage=Stage(runtime);if(!Directory.Exists(stage))return;
  var pins=Pin(productRoot,dataRoot,runtime,false);try{
   pins.Add(ServiceDirectoryPin.Directory(stage));SafeAcl(stage,Sid(),true);var journal=ReadJournal(stage);
   var manifestEntry=journal.files.SingleOrDefault(entry=>String.Equals(entry.name,Manifest,StringComparison.OrdinalIgnoreCase));
   Need(manifestEntry!=null,"VOICE_RETIRE_JOURNAL_INVALID");
   string stagedManifest=Path.Combine(stage,Manifest);
   if(File.Exists(stagedManifest))Need(HashFile(stagedManifest)==manifestEntry.sha256&&ValidManifest(stagedManifest),"VOICE_RETIRE_MANIFEST_INVALID");
   foreach(var entry in journal.files){string source=Path.Combine(stage,entry.name);if(!File.Exists(source))continue;
    SafeAcl(source,Sid(),false);Need(HashFile(source)==entry.sha256,"VOICE_RETIRE_FILE_CHANGED");
    if(rollback){Need(!File.Exists(Path.Combine(runtime,entry.name)),"VOICE_RETIRE_RESTORE_CONFLICT");File.Move(source,Path.Combine(runtime,entry.name));}
    else File.Delete(source);
   }
   string marker=Path.Combine(stage,JournalName);File.Delete(marker);
  }finally{for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();}
  if(!Directory.EnumerateFileSystemEntries(stage).Any())Directory.Delete(stage,false);
 }
}
