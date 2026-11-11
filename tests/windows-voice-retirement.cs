using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Runtime.InteropServices;

internal static class LegacyVoiceRetirementTest {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateHardLink(string path,string existing,IntPtr security);
 static void Assert(bool ok,string message){if(!ok)throw new Exception(message);}
 static string Sha(string value){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-","").ToLowerInvariant();}
 static void Main(string[] args){
  string root=Path.GetFullPath(args[0]);string parent=Path.Combine(root,"local-voice"),runtime=Path.Combine(parent,"voice-runtime");
  Directory.CreateDirectory(runtime);
  string managed=Path.Combine(runtime,"known.bin"),changed=Path.Combine(runtime,"changed.bin"),other=Path.Combine(runtime,"personal.txt");
  File.WriteAllText(managed,"verified product file",new UTF8Encoding(false));
  File.WriteAllText(changed,"user modified file",new UTF8Encoding(false));
  File.WriteAllText(other,"personal data",new UTF8Encoding(false));
  string manifest=Path.Combine(runtime,"runtime-manifest.json");
  File.WriteAllText(manifest,"{\"schemaVersion\":1,\"whisperCppRelease\":\"b5454 (v1.9.5)\",\"modelRepository\":\"ggerganov/whisper.cpp\",\"modelRevision\":\"f281eb45af861ab5e5297d23694b7d46e090c02c\"}",new UTF8Encoding(false));
  LegacyVoiceRetirement.SetKnownForTest("known.bin",Sha("verified product file"));
  LegacyVoiceRetirement.AddKnownForTest("changed.bin",Sha("original product file"));
  LegacyVoiceRetirement.Prepare(root,root,runtime);
  Assert(!File.Exists(managed)&&!File.Exists(manifest),"managed files were not quarantined");
  Assert(File.ReadAllText(other)=="personal data"&&File.ReadAllText(changed)=="user modified file","unrelated data changed");
  LegacyVoiceRetirement.Finish(root,root,runtime,true);
  Assert(File.ReadAllText(managed)=="verified product file"&&File.Exists(manifest),"rollback did not restore managed files");
  Assert(!Directory.Exists(Path.Combine(parent,".agentoc-retired-whisper")),"rollback left a transaction directory");
  LegacyVoiceRetirement.Prepare(root,root,runtime);
  LegacyVoiceRetirement.Finish(root,root,runtime,false);
  Assert(!File.Exists(managed)&&!File.Exists(manifest),"commit did not remove verified files");
  Assert(File.ReadAllText(other)=="personal data"&&File.ReadAllText(changed)=="user modified file","commit altered personal data");
  string malformedRoot=Path.Combine(root,"malformed"),malformedRuntime=Path.Combine(malformedRoot,"voice-runtime");
  Directory.CreateDirectory(malformedRuntime);
  File.WriteAllText(Path.Combine(malformedRuntime,"runtime-manifest.json"),"not a product manifest",new UTF8Encoding(false));
  File.WriteAllText(Path.Combine(malformedRuntime,"known.bin"),"verified product file",new UTF8Encoding(false));
  LegacyVoiceRetirement.Prepare(malformedRoot,malformedRoot,malformedRuntime);
  Assert(File.Exists(Path.Combine(malformedRuntime,"known.bin")),"invalid manifest did not preserve files");
  string collisionRoot=Path.Combine(root,"collision"),collisionRuntime=Path.Combine(collisionRoot,"voice-runtime");
  Directory.CreateDirectory(collisionRuntime);
  string collisionFile=Path.Combine(collisionRuntime,"known.bin");
  File.WriteAllText(collisionFile,"verified product file",new UTF8Encoding(false));
  File.WriteAllText(Path.Combine(collisionRuntime,"runtime-manifest.json"),"{\"schemaVersion\":1,\"whisperCppRelease\":\"b5454 (v1.9.5)\",\"modelRepository\":\"ggerganov/whisper.cpp\",\"modelRevision\":\"f281eb45af861ab5e5297d23694b7d46e090c02c\"}",new UTF8Encoding(false));
  LegacyVoiceRetirement.Prepare(collisionRoot,collisionRoot,collisionRuntime);
  File.WriteAllText(collisionFile,"personal replacement",new UTF8Encoding(false));
  bool refused=false;try{LegacyVoiceRetirement.Finish(collisionRoot,collisionRoot,collisionRuntime,true);}catch(InvalidOperationException){refused=true;}
  Assert(refused&&File.ReadAllText(collisionFile)=="personal replacement","rollback overwrote a new file");
  Assert(File.ReadAllText(Path.Combine(collisionRoot,".agentoc-retired-whisper","known.bin"))=="verified product file","rollback conflict lost the quarantined file");
  string hardRoot=Path.Combine(root,"hardlink"),hardRuntime=Path.Combine(hardRoot,"voice-runtime");
  Directory.CreateDirectory(hardRuntime);
  string hardFile=Path.Combine(hardRuntime,"known.bin"),hardAlias=Path.Combine(hardRoot,"personal-link.bin");
  File.WriteAllText(hardFile,"verified product file",new UTF8Encoding(false));
  Assert(CreateHardLink(hardAlias,hardFile,IntPtr.Zero),"could not create test hard link");
  File.WriteAllText(Path.Combine(hardRuntime,"runtime-manifest.json"),"{\"schemaVersion\":1,\"whisperCppRelease\":\"b5454 (v1.9.5)\",\"modelRepository\":\"ggerganov/whisper.cpp\",\"modelRevision\":\"f281eb45af861ab5e5297d23694b7d46e090c02c\"}",new UTF8Encoding(false));
  bool hardRefused=false;try{LegacyVoiceRetirement.Prepare(hardRoot,hardRoot,hardRuntime);}catch(InvalidOperationException){hardRefused=true;}
  Assert(hardRefused&&File.ReadAllText(hardAlias)=="verified product file"&&File.Exists(hardFile),"hard-linked user data was not protected");
  Console.WriteLine("legacy voice retirement transaction passed");
 }
}
