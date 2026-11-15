using System;using System.IO;using System.Runtime.InteropServices;using Ragent.ServiceHost;
static class IdentityInputPinProbe {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateHardLink(string target,string source,IntPtr security);
 static void Need(bool condition){if(!condition)throw new Exception("QA_INPUT_PIN_FAILED");}
 public static int Main(string[] args){
  string path=Path.Combine(args[0],"input"),alias=Path.Combine(args[0],"alias"),other=Path.Combine(args[0],"other");File.WriteAllText(path,"QA owned input");File.WriteAllText(other,"QA other");
  using(var f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){
   ServiceDirectoryPin.VerifyFile(f.SafeFileHandle,path);
   bool denied=false;try{File.WriteAllText(path,"replacement");}catch(IOException){denied=true;}Need(denied);
   denied=false;try{File.Move(path,alias);}catch(IOException){denied=true;}Need(denied);
   denied=false;try{ServiceDirectoryPin.VerifyFile(f.SafeFileHandle,other);}catch(InvalidOperationException e){denied=e.Message=="SHT_FILE_IDENTITY_REFUSED";}Need(denied);
  }
  Need(CreateHardLink(alias,path,IntPtr.Zero));using(var f=File.OpenRead(path)){bool denied=false;try{ServiceDirectoryPin.VerifyFile(f.SafeFileHandle,path);}catch(InvalidOperationException e){denied=e.Message=="SHT_FILE_IDENTITY_REFUSED";}Need(denied);}
  Console.WriteLine("{\"pass\":true,\"actualFileChecks\":5,\"productionChanged\":false}");return 0;
 }
}
