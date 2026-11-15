using System;
using System.Reflection;
using Ragent.ServiceHost;

public static class AdministrativeInputStageTest {
    public static int Main() {
        var method=typeof(RagentService).GetMethod("AdministrativeInputStage",BindingFlags.NonPublic|BindingFlags.Static);
        if(method==null)throw new Exception("Missing diagnostic classifier");
        string input=@"C:\ProgramData\Ragent\instances\owner\security\owner-bootstrap-install.json";
        Check(method,@"C:\",input,false,"SHT_INPUT_DRIVE_ROOT");
        Check(method,@"C:\ProgramData",input,false,"SHT_INPUT_PROGRAMDATA");
        Check(method,@"C:\Program Files",input,false,"SHT_INPUT_PROGRAM_FILES");
        Check(method,@"C:\ProgramData\Ragent\instances\owner\security",input,false,"SHT_INPUT_PARENT");
        Check(method,@"C:\ProgramData\Ragent",input,false,"SHT_INPUT_OTHER_ANCESTOR");
        Check(method,input,input,true,"SHT_INPUT_FILE");
        var permission=typeof(RagentService).GetMethod("AllowPinnedProgramDataAncestor",BindingFlags.NonPublic|BindingFlags.Static);
        if(permission==null)throw new Exception("Missing ProgramData guard");
        CheckPermission(permission,@"C:\ProgramData",0x2,true);
        CheckPermission(permission,@"c:\programdata\",0x100,true);
        CheckPermission(permission,@"C:\ProgramData",0x40,false);
        CheckPermission(permission,@"C:\ProgramData",0x40000,false);
        CheckPermission(permission,@"C:\ProgramData\Ragent",0x2,false);
        CheckPermission(permission,@"G:\ProgramData",0x2,false);
        Console.WriteLine("Administrative input diagnostics passed.");
        return 0;
    }
    private static void CheckPermission(MethodInfo method,string path,long rights,bool expected) {
        var result=(bool)method.Invoke(null,new object[]{path,rights});
        if(result!=expected)throw new Exception("Unexpected ProgramData guard result");
    }
    private static void Check(MethodInfo method,string path,string input,bool file,string expected) {
        var result=(string)method.Invoke(null,new object[]{path,input,file});
        if(result!=expected)throw new Exception("Unexpected diagnostic category: "+result);
    }
}
