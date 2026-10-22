// SPDX-License-Identifier: GPL-3.0-or-later
#include <napi/native_api.h>
#include <string>
#include <memory>
extern "C" char* jap_harmony_request(const char*);
extern "C" void jap_harmony_free(char*);
struct Work {std::string input,output;napi_async_work task;napi_deferred result;};
static napi_value Request(napi_env env,napi_callback_info info) {
  size_t count=1;napi_value arg;napi_get_cb_info(env,info,&count,&arg,nullptr,nullptr);
  size_t len=0;
  if(count!=1||napi_get_value_string_utf8(env,arg,nullptr,0,&len)!=napi_ok||len>8*1024*1024){napi_throw_type_error(env,nullptr,"Invalid native request");return nullptr;}
  auto work=new Work();work->input.resize(len+1);napi_get_value_string_utf8(env,arg,work->input.data(),len+1,&len);work->input.resize(len);
  napi_value promise,name;napi_create_promise(env,&work->result,&promise);napi_create_string_utf8(env,"jap-engine",NAPI_AUTO_LENGTH,&name);
  napi_create_async_work(env,nullptr,name,[](napi_env,void* data){
    auto w=static_cast<Work*>(data);char* result=jap_harmony_request(w->input.c_str());w->output=result?result:"{\"error\":\"Native allocation failed\"}";jap_harmony_free(result);
  },[](napi_env env,napi_status status,void* data){
    std::unique_ptr<Work> w(static_cast<Work*>(data));napi_value out;napi_create_string_utf8(env,w->output.c_str(),w->output.size(),&out);
    if(status==napi_ok)napi_resolve_deferred(env,w->result,out);else napi_reject_deferred(env,w->result,out);napi_delete_async_work(env,w->task);
  },work,&work->task);napi_queue_async_work(env,work->task);return promise;
}
static napi_value Init(napi_env env,napi_value exports){napi_property_descriptor desc={"request",nullptr,Request,nullptr,nullptr,nullptr,napi_default,nullptr};napi_define_properties(env,exports,1,&desc);return exports;}
static napi_module module={1,0,nullptr,Init,"player",nullptr,{0}};
extern "C" __attribute__((constructor)) void Register(){napi_module_register(&module);}
