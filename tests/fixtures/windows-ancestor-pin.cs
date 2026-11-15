// Actual metadata-only junction attacks on owned fixture directories. This is
// never installed. The positive empty-directory control must succeed first.
using System;using System.IO;using System.Text;using System.Collections.Generic;
using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
using System.Web.Script.Serialization;
public static class AncestorMutationProbe {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFile(string p,uint access,uint share,IntPtr sa,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool DeviceIoControl(SafeFileHandle h,uint code,byte[] input,int length,IntPtr output,int size,out int returned,IntPtr overlapped);
 public static int Junction(string path,string target) {
  byte[] substitute=Encoding.Unicode.GetBytes(@"\??\"+Path.GetFullPath(target)),print=Encoding.Unicode.GetBytes(Path.GetFullPath(target));
  var b=new byte[16+substitute.Length+2+print.Length+2];
  Array.Copy(BitConverter.GetBytes(0xa0000003u),0,b,0,4);Array.Copy(BitConverter.GetBytes((ushort)(b.Length-8)),0,b,4,2);
  Array.Copy(BitConverter.GetBytes((ushort)substitute.Length),0,b,10,2);Array.Copy(BitConverter.GetBytes((ushort)(substitute.Length+2)),0,b,12,2);Array.Copy(BitConverter.GetBytes((ushort)print.Length),0,b,14,2);
  Array.Copy(substitute,0,b,16,substitute.Length);Array.Copy(print,0,b,18+substitute.Length,print.Length);
  using(var h=CreateFile(path,0x100,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
   if(h.IsInvalid)return Marshal.GetLastWin32Error();int count;
   return DeviceIoControl(h,0x900a4,b,b.Length,IntPtr.Zero,0,out count,IntPtr.Zero)?0:Marshal.GetLastWin32Error();
  }
 }
 static void Need(bool ok,string name){if(!ok)throw new InvalidOperationException("ANCESTOR_PROBE_"+name);}
 public static string Run(string root,Func<string,string,SafeFileHandle[]> guard,Func<string,SafeFileHandle> single) {
  Need(Directory.Exists(root)&&Directory.GetFileSystemEntries(root).Length==0,"FRESH_ROOT");
  var checks=new List<string>();string target=Path.Combine(root,"target"),empty=Path.Combine(root,"empty"),parent=Path.Combine(root,"parent"),child=Path.Combine(parent,"witness");
  Directory.CreateDirectory(target);Directory.CreateDirectory(empty);Directory.CreateDirectory(child);
  using(var pinned=single(empty)) {
   Need(Junction(empty,target)==0,"METADATA_CONTROL_MUST_SUCCEED");
   Need((File.GetAttributes(empty)&FileAttributes.ReparsePoint)!=0,"CONTROL_IS_REPARSE");
  }
  Directory.Delete(empty);checks.Add("metadata-only-junction-succeeds-despite-single-directory-pin");
  var pins=guard(parent,child);
  try {
   Need(Junction(parent,target)==145,"NONEMPTY_REPARSE_MUST_RETURN_145");checks.Add("pinned-nonempty-parent-reparse-denied-145");
   bool refused=false;try{Directory.Move(child,Path.Combine(parent,"moved"));}catch(IOException){refused=true;}Need(refused,"CHILD_RENAME");checks.Add("pinned-child-rename-denied");
   refused=false;try{Directory.Delete(child);}catch(IOException){refused=true;}Need(refused,"CHILD_DELETE");checks.Add("pinned-child-delete-denied");
   refused=false;try{Directory.Move(parent,Path.Combine(root,"moved-parent"));}catch(IOException){refused=true;}Need(refused,"PARENT_RENAME");checks.Add("pinned-parent-rename-denied");
   Need((File.GetAttributes(parent)&FileAttributes.ReparsePoint)==0,"PARENT_CHANGED");
  }finally{for(int i=pins.Length-1;i>=0;i--)pins[i].Dispose();}
  Directory.Move(child,Path.Combine(parent,"moved"));Directory.Delete(Path.Combine(parent,"moved"));
  Need(Junction(parent,target)==0,"AFTER_RELEASE_CONTROL");Directory.Delete(parent);checks.Add("junction-succeeds-only-after-child-removed-and-pins-released");
  bool bad=false;try{var h=guard(target,Path.Combine(target,"missing"));foreach(var x in h)x.Dispose();}catch{bad=true;}Need(bad,"MISSING_WITNESS");checks.Add("missing-child-refused");
  bad=false;try{var h=guard(root,target+"\\nested");foreach(var x in h)x.Dispose();}catch{bad=true;}Need(bad,"NONIMMEDIATE_WITNESS");checks.Add("non-immediate-child-refused");
  string link=Path.Combine(root,"link");Directory.CreateDirectory(link);Need(Junction(link,target)==0,"LINK_CONTROL");
  bad=false;try{var h=guard(root,link);foreach(var x in h)x.Dispose();}catch{bad=true;}Need(bad,"REPARSE_WITNESS");Directory.Delete(link);checks.Add("reparse-child-refused");
  Directory.Delete(target);
  Need(Directory.GetFileSystemEntries(root).Length==0,"FIXTURE_NOT_EMPTY");
  return new JavaScriptSerializer().Serialize(new{pass=true,checks=checks,metadataOnlyAccess=256,ownedDirectoriesOnly=true,pid=System.Diagnostics.Process.GetCurrentProcess().Id,sid=System.Security.Principal.WindowsIdentity.GetCurrent().User.Value});
 }
}
#if HOST_PROBE
static class HostAncestorProbe {
 public static int Main(string[] args) {
  try {Console.WriteLine(AncestorMutationProbe.Run(args[0],Ragent.ServiceHost.ServiceDirectoryPin.NonemptyDirectory,Ragent.ServiceHost.ServiceDirectoryPin.Directory));return 0;}
  catch(Exception e){Console.Error.WriteLine(e.ToString());return 1;}
 }
}
#endif
