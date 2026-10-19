// Minimal C ABI for the LGPL DST decoder. Local wrapper: validates buffers,
// contains C++ exceptions and suppresses per-bit console logging.
#include "dst_wrapper.h"
#include "decoder.h"
#include <cstring>
#include <new>
void log_printf(const char*, ...) {}
struct DstDecoder { dst_Decoder_t dec; size_t len; };
extern "C" {
void* dst_decoder_new(uint32_t channels,uint32_t frame_size) {
    if(channels<1||channels>6||frame_size!=4704)return nullptr;
    try { auto* p=new DstDecoder();p->len=channels*frame_size;if(p->dec.init(channels,frame_size)!=0){delete p;return nullptr;}return p; }
    catch(...) { return nullptr; }
}
void dst_decoder_free(void* handle) { auto* p=static_cast<DstDecoder*>(handle);if(p){p->dec.close();delete p;} }
int dst_decoder_decode(void* handle,const uint8_t* data,size_t len,uint8_t* out,size_t out_len) {
    auto* p=static_cast<DstDecoder*>(handle);
    if(!p||!data||!out||len==0||len>65536||out_len<p->len)return -1;
    if((data[0]&128)==0&&len!=p->len+1)return -1;
    try {std::memset(out,0,p->len);return p->dec.run(data,static_cast<unsigned>(len*8),out);}catch(...){return -1;}
}
}
