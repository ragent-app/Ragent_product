// Compile beside the shipped ServiceHost, selecting only this test entry point.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Ragent.ServiceHost;

static class ServiceHostEnvironmentProbe {
  static void Need(bool condition,string name){if(!condition)throw new InvalidOperationException(name);}
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
  static readonly string[] Secrets={"RAGENT_AUTH_SESSION_SECRET","ragent_auth_session_secret","RAGENT_FIREBASE_ADMIN_JSON","GOOGLE_APPLICATION_CREDENTIALS","ANTHROPIC_API_KEY","OPENAI_API_KEY","CODEX_HOME","CLAUDE_CONFIG_DIR","NODE_OPTIONS","NODE_PATH","HTTP_PROXY","RAGENT_NATIVE_REGISTRY_DIR","RAGENT_SECRET_NOT_YET_KNOWN"};
  static ProcessStartInfo Info(string root,string node,string script,string role){
    string config=Path.Combine(root,"config");Directory.CreateDirectory(config);
    return new RagentService("Ragent-EnvironmentQA",role,node,script,root,config).BuildChildStartInfo();
  }
  public static int Main(string[] args){
    var result=new Dictionary<string,object>{{"pass",false},{"serviceCreated",false},{"productionTouched",false}};var checks=new List<string>();
    try{
      Need(args.Length==5,"fixture arguments");string root=args[0],node=args[1],probe=args[2],supervisor=args[3],controlProbe=args[4];
      foreach(string name in Secrets)Environment.SetEnvironmentVariable(name,name=="HTTP_PROXY"?"http://user:SYNTHETIC@127.0.0.1:8911":"SYNTHETIC-DO-NOT-INHERIT");
      foreach(string name in new[]{"HTTPS_PROXY","ALL_PROXY","NO_PROXY"})Environment.SetEnvironmentVariable(name,null);
      Environment.SetEnvironmentVariable("RAGENT_RUN_SPOOL_DIR","SYNTHETIC-WRONG-SPOOL");
      foreach(string mode in new[]{"malformed","missing","directory"}){
        string home=Path.Combine(root,mode),config=Path.Combine(home,"config"),secret=Path.Combine(config,"auth-session-secret");Directory.CreateDirectory(config);
        if(mode=="malformed")File.WriteAllText(secret,"SYNTHETIC-INVALID-SECRET");
        if(mode=="directory")Directory.CreateDirectory(secret);
        var info=Info(home,node,probe,"supervisor");
        foreach(string name in Secrets)Need(!info.EnvironmentVariables.ContainsKey(name),"supervisor inherited forbidden variable");
        Need(info.EnvironmentVariables["RAGENT_RUN_SPOOL_DIR"]==Path.Combine(home,"data","chat-runs"),"scoped spool");
        Need(info.EnvironmentVariables["RAGENT_PROVIDER_HOMES_DIR"]==Path.Combine(home,"provider-homes"),"scoped homes");
        using(var child=Process.Start(info)){
          var output=child.StandardOutput.ReadToEndAsync();var error=child.StandardError.ReadToEndAsync();
          try{Need(child.WaitForExit(15000),"probe timeout");
            Need(child.ExitCode==0&&Json.Deserialize<Dictionary<string,object>>(output.Result)["pass"].Equals(true),"actual Node environment refused");
            Need(error.Result.Length==0,"unexpected Node diagnostic");
          }finally{if(!child.HasExited){child.Kill();child.WaitForExit(5000);}}
        }
        if(mode=="malformed")Need(File.ReadAllText(secret)=="SYNTHETIC-INVALID-SECRET","supervisor modified secret");
        if(mode=="missing")Need(!File.Exists(secret),"supervisor created secret");
        if(mode=="directory")Need(Directory.Exists(secret),"supervisor touched secret directory");
        checks.Add("supervisor-"+mode+"-secret-no-read-or-create");
      }
      // Existing credential-free proxy configuration stays usable; embedded
      // credentials, unsupported schemes and URL baggage never cross roles.
      foreach(string proxy in new[]{"http://user:SYNTHETIC@127.0.0.1:8911","file:///SYNTHETIC"}){
        Environment.SetEnvironmentVariable("HTTP_PROXY",proxy);Need(!Info(Path.Combine(root,"proxy"),node,probe,"supervisor").EnvironmentVariables.ContainsKey("HTTP_PROXY"),"unsafe proxy inherited");
      }
      Environment.SetEnvironmentVariable("HTTP_PROXY","http://127.0.0.1:8911/private?SYNTHETIC=secret#private");
      Need(Info(Path.Combine(root,"proxy"),node,probe,"supervisor").EnvironmentVariables["HTTP_PROXY"]=="http://127.0.0.1:8911/","public proxy changed or URL baggage copied");
      Environment.SetEnvironmentVariable("HTTP_PROXY",null);checks.Add("public-proxy-preserved-credentials-and-url-baggage-refused");
      const string featureFlag="RAGENT_TEMPORARY_PAIRING_ENABLED";
      string featureRoot=Path.Combine(root,"temporary-feature");
      foreach(string value in new[]{"0","true","01","1 ","SYNTHETIC",null}){
        Environment.SetEnvironmentVariable(featureFlag,value);
        foreach(string role in new[]{"control","supervisor"})Need(!Info(featureRoot,node,probe,role).EnvironmentVariables.ContainsKey(featureFlag),"invalid or unset temporary feature inherited");
      }
      Environment.SetEnvironmentVariable(featureFlag,"1");
      Need(!Info(featureRoot,node,probe,"supervisor").EnvironmentVariables.ContainsKey(featureFlag),"supervisor inherited temporary feature");
      var enabledControl=Info(featureRoot,node,controlProbe,"control");
      Need(enabledControl.EnvironmentVariables[featureFlag]=="1","control lost explicit temporary feature");
      var initializer=new RagentService("Ragent-EnvironmentQA","control",node,probe,featureRoot,Path.Combine(featureRoot,"config"));
      var initialInfo=(ProcessStartInfo)typeof(RagentService).GetMethod("BuildChildStartInfoCore",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance).Invoke(initializer,new object[]{true});
      Need(!initialInfo.EnvironmentVariables.ContainsKey(featureFlag)&&!initialInfo.EnvironmentVariables.ContainsKey("RAGENT_AUTH_SESSION_SECRET"),"identity initializer inherited feature or auth secret");
      using(var child=Process.Start(enabledControl)){
        var output=child.StandardOutput.ReadToEndAsync();var error=child.StandardError.ReadToEndAsync();
        try{Need(child.WaitForExit(15000),"control feature probe timeout");
          Need(child.ExitCode==0&&Json.Deserialize<Dictionary<string,object>>(output.Result)["pass"].Equals(true),"actual Control Node feature environment refused");
          Need(error.Result.Length==0,"unexpected Control Node diagnostic");
        }finally{if(!child.HasExited){child.Kill();child.WaitForExit(5000);}}
      }
      Environment.SetEnvironmentVariable(featureFlag,null);
      checks.Add("temporary-feature-explicit-one-control-only-actual-node");
      string[] rolloutFlags=new[]{
        "RAGENT_ORG_SCHEMA_ENABLED","RAGENT_ORG_SHADOW_PROJECTION","RAGENT_ORG_SESSION_ADDRESSABILITY_ENABLED",
        "RAGENT_MANAGED_INPUT_ENFORCEMENT","RAGENT_MANAGED_WRITER_ENABLED","RAGENT_REVIEWER_ENABLED",
        "RAGENT_COLLABORATION_LEADER_ENABLED","RAGENT_ORG_INTERNAL_ENVELOPE_ENABLED","RAGENT_ORG_AUTONOMOUS_LEADER_ENABLED",
        "RAGENT_ORG_AUTONOMOUS_PROVISIONING_ENABLED","RAGENT_ORG_AUTONOMOUS_AUTO_PROVISIONING_ENABLED",
        "RAGENT_ORG_HIERARCHICAL_DELEGATION_ENABLED","RAGENT_ORG_DYNAMIC_REPLAN_ENABLED","RAGENT_ORG_STALL_GOVERNOR_ENABLED",
        "RAGENT_ORG_PROJECTION_V1_ENABLED","RAGENT_ORG_PROJECTION_V2_ENABLED","RAGENT_ORG_RECOVERY_V1_ENABLED",
        "RAGENT_CONSULTATION_V1_ENABLED"
      };
      string rolloutRoot=Path.Combine(root,"rollout-flags");
      foreach(string name in rolloutFlags)Environment.SetEnvironmentVariable(name,null);
      var rolloutControl=Info(rolloutRoot,node,probe,"control");
      var rolloutSupervisor=Info(rolloutRoot,node,probe,"supervisor");
      var rolloutInitService=new RagentService("Ragent-EnvironmentQA","control",node,probe,rolloutRoot,Path.Combine(rolloutRoot,"config"));
      var rolloutInit=(ProcessStartInfo)typeof(RagentService).GetMethod("BuildChildStartInfoCore",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance).Invoke(rolloutInitService,new object[]{true});
      foreach(string name in rolloutFlags){
        Need(rolloutControl.EnvironmentVariables[name]=="1","control missing default rollout flag "+name);
        Need(!rolloutSupervisor.EnvironmentVariables.ContainsKey(name),"supervisor inherited control rollout flag "+name);
        Need(!rolloutInit.EnvironmentVariables.ContainsKey(name),"identity initializer inherited rollout flag "+name);
      }
      foreach(string optOut in new[]{"0","false","NO"," off "}){
        Environment.SetEnvironmentVariable("RAGENT_ORG_PROJECTION_V2_ENABLED",optOut);
        Need(Info(rolloutRoot,node,probe,"control").EnvironmentVariables["RAGENT_ORG_PROJECTION_V2_ENABLED"]=="0","control ignored rollout opt-out");
        Need(!Info(rolloutRoot,node,probe,"supervisor").EnvironmentVariables.ContainsKey("RAGENT_ORG_PROJECTION_V2_ENABLED"),"supervisor inherited rollout opt-out");
      }
      Environment.SetEnvironmentVariable("RAGENT_ORG_SCHEMA_ENABLED","SYNTHETIC");
      Need(Info(rolloutRoot,node,probe,"control").EnvironmentVariables["RAGENT_ORG_SCHEMA_ENABLED"]=="1","control forwarded ambient rollout string");
      foreach(string name in rolloutFlags)Environment.SetEnvironmentVariable(name,null);
      checks.Add("organization-rollout-flags-control-only-with-normalized-opt-out");
      const string providerReadOnlyFlag="RAGENT_CODEX_PROVIDER_READONLY";
      foreach(string value in new[]{"0","true","01","1 ","SYNTHETIC",null}){
        Environment.SetEnvironmentVariable(providerReadOnlyFlag,value);
        foreach(string role in new[]{"control","supervisor"})Need(!Info(rolloutRoot,node,probe,role).EnvironmentVariables.ContainsKey(providerReadOnlyFlag),"invalid or unset provider readonly inherited");
      }
      Environment.SetEnvironmentVariable(providerReadOnlyFlag,"1");
      Need(Info(rolloutRoot,node,probe,"control").EnvironmentVariables[providerReadOnlyFlag]=="1","control lost explicit provider readonly");
      Need(Info(rolloutRoot,node,probe,"supervisor").EnvironmentVariables[providerReadOnlyFlag]=="1","supervisor lost explicit provider readonly");
      var readOnlyInit=(ProcessStartInfo)typeof(RagentService).GetMethod("BuildChildStartInfoCore",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance).Invoke(rolloutInitService,new object[]{true});
      Need(!readOnlyInit.EnvironmentVariables.ContainsKey(providerReadOnlyFlag),"identity initializer inherited provider readonly");
      Environment.SetEnvironmentVariable(providerReadOnlyFlag,null);
      checks.Add("codex-provider-readonly-explicit-one-control-and-supervisor-only");
      string controlRoot=Path.Combine(root,"control"),controlConfig=Path.Combine(controlRoot,"config");Directory.CreateDirectory(controlConfig);
      string controlSecret=Path.Combine(controlConfig,"auth-session-secret");
      var first=Info(controlRoot,node,probe,"control");string persisted=File.ReadAllText(controlSecret);
      foreach(string name in Secrets)if(!String.Equals(name,"RAGENT_AUTH_SESSION_SECRET",StringComparison.OrdinalIgnoreCase))Need(!first.EnvironmentVariables.ContainsKey(name),"control inherited foreign parent secret or Node hook");
      Need(persisted.Length==64&&first.EnvironmentVariables["RAGENT_AUTH_SESSION_SECRET"]==persisted,"control owns creation");
      var second=Info(controlRoot,node,probe,"control");Need(second.EnvironmentVariables["RAGENT_AUTH_SESSION_SECRET"]==persisted,"control rotated existing secret");
      checks.Add("control-create-and-reuse-persisted-secret");
      File.WriteAllText(controlSecret,"INVALID");bool denied=false;
      try{Info(controlRoot,node,probe,"control");}catch(InvalidOperationException){denied=true;}
      Need(denied&&File.ReadAllText(controlSecret)=="INVALID","control malformed secret not refused");checks.Add("control-malformed-secret-fails-closed");
      denied=false;try{Info(root,node,probe,"unknown");}catch(ArgumentException){denied=true;}Need(denied,"unknown role");checks.Add("unknown-role-refused");
      // Start the real supervisor entry with a unique QA pipe. It never binds
      // the installed owner endpoint or receives a Run/Provider request.
      string daemonRoot=Path.Combine(root,"daemon");var daemon=Info(daemonRoot,node,supervisor,"supervisor");
      daemon.EnvironmentVariables["RAGENT_RUNNER_SUPERVISOR_SOCKET"]="\\\\.\\pipe\\ragent-service-env-"+Guid.NewGuid().ToString("N");
      string stop=daemon.EnvironmentVariables["RAGENT_WINDOWS_SERVICE_STOP_FILE"];
      Directory.CreateDirectory(Path.GetDirectoryName(stop));var ready=new ManualResetEvent(false);
      using(var child=new Process{StartInfo=daemon}){
        child.OutputDataReceived+=(_,line)=>{if(line.Data!=null&&line.Data.Contains("[runner-supervisor] listening"))ready.Set();};
        child.ErrorDataReceived+=(_,line)=>{};
        try{Need(child.Start(),"daemon start");child.BeginOutputReadLine();child.BeginErrorReadLine();Need(ready.WaitOne(20000),"real supervisor readiness");
          File.WriteAllText(stop,DateTime.UtcNow.ToString("o"));Need(child.WaitForExit(15000)&&child.ExitCode==0,"real supervisor graceful stop");
        }finally{if(!child.HasExited){child.Kill();child.WaitForExit(5000);}}
      }
      checks.Add("actual-supervisor-private-pipe-start-and-graceful-stop");
      result["pass"]=true;
    }catch(Exception error){result["errorType"]=error.GetType().Name;result["error"]=error.Message;}
    result["checks"]=checks;Console.WriteLine(Json.Serialize(result));return (bool)result["pass"]?0:1;
  }
}
