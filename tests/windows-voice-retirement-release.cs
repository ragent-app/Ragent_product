// Run only against an isolated copy of the exact legacy managed runtime.
using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;

internal static class LegacyVoiceRetirementReleaseTest {
 static void Assert(bool ok,string message){if(!ok)throw new Exception(message);}
 static string Hash(string path){using(var file=File.OpenRead(path))using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(file)).Replace("-","");}
 static void Main(string[] args){
  string root=Path.GetFullPath(args[0]),runtime=Path.Combine(root,"voice-runtime");
  var before=Directory.GetFiles(runtime).ToDictionary(Path.GetFileName,Hash,StringComparer.OrdinalIgnoreCase);
  Assert(before.Count==17&&before.ContainsKey("runtime-manifest.json"),"fixture is not the expected complete runtime");
  File.WriteAllText(Path.Combine(runtime,"personal.txt"),"preserve");
  LegacyVoiceRetirement.Prepare(root,root,runtime);
  Assert(Directory.GetFiles(runtime).Length==1&&File.Exists(Path.Combine(runtime,"personal.txt")),"not all verified runtime files were quarantined");
  LegacyVoiceRetirement.Finish(root,root,runtime,true);
  foreach(var item in before)Assert(Hash(Path.Combine(runtime,item.Key))==item.Value,"rollback changed "+item.Key);
  Assert(File.ReadAllText(Path.Combine(runtime,"personal.txt"))=="preserve","rollback altered unrelated data");
  LegacyVoiceRetirement.Prepare(root,root,runtime);
  LegacyVoiceRetirement.Finish(root,root,runtime,false);
  Assert(Directory.GetFiles(runtime).Length==1&&File.ReadAllText(Path.Combine(runtime,"personal.txt"))=="preserve","commit did not remove the verified runtime safely");
  Console.WriteLine("legacy voice retirement real release fixture passed");
 }
}
