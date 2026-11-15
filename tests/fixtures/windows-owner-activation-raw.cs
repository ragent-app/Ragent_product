using System;
using System.Collections.Generic;
using System.Threading;
partial class WindowsOwnerBootstrap {
 internal static int ActivationRawProbe(){
  var timer=new Timer(_=>Environment.Exit(2),null,20000,Timeout.Infinite);
  try{
   var input=Parse(ParentLine());
   if(input.ContainsKey("ownerSessionSid")){Dictionary<string,object> ownFacts;using(var own=new ProcessPin(System.Diagnostics.Process.GetCurrentProcess().Id))ownFacts=Facts(System.Diagnostics.Process.GetCurrentProcess().Id,own.Handle);Emit(new{kind="wts",sessionId=RagentOwnerSessions.Find(Str(input,"ownerSessionSid")),facts=ownFacts});return 0;}
   var policy=(Dictionary<string,object>)input["policy"];string fault=Str(input,"fault");
   Require(fault=="receipt-missing"||fault=="commit-abort","OBC_FIXTURE_INVALID");
   Dictionary<string,object> self;using(var own=new ProcessPin(System.Diagnostics.Process.GetCurrentProcess().Id))self=Facts(System.Diagnostics.Process.GetCurrentProcess().Id,own.Handle);
   ActivationPolicy(policy,false,self);PermitPeerQuery(Str(policy,"controlSid"));
   using(var pipe=Client("ragent-owner-activation-"+Str(policy,"instanceId"))){
    Dictionary<string,object> facts;using(var pin=ActivationPin(pipe,false,policy,out facts)){
     var request=Parse(ReadFrame(pipe));ActivationFrame(request,policy,"challenge");request["operation"]="owner.activation.request";request["launchNonce"]=Guid.NewGuid().ToString("N")+Guid.NewGuid().ToString("N");WriteFrame(pipe,Json.Serialize(request));
     ActivationFrame(Parse(ReadFrame(pipe)),policy,"ready",request);
     if(fault=="receipt-missing"){Emit(new{kind="ready",facts=facts});return 0;}
     var receipt=new Dictionary<string,object>(request);receipt["operation"]="owner.activation.receipt";WriteFrame(pipe,Json.Serialize(receipt));Emit(new{kind="waiting-commit",facts=facts});
     ActivationFrame(Parse(ReadFrame(pipe)),policy,"committed",request);throw new InvalidOperationException("OBC_FIXTURE_ABORT_NOT_OBSERVED");
    }
   }
  }catch(Exception error){Emit(new{kind="error",code=error.Message.StartsWith("OBC_")||error.Message.StartsWith("OSV_")?error.Message:"OBC_TRANSPORT_FAILED"});return 1;}
  finally{timer.Dispose();}
 }
}
class OwnerActivationRawMain {public static int Main(){return WindowsOwnerBootstrap.ActivationRawProbe();}}
