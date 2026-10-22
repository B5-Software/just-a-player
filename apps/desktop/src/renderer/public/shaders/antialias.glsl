// B5-Software, GPL-3.0-or-later. Edge-directed antialiasing in linear HDR.
// Both WebGL/offline and native EGL load this exact file; JA_TEXTURE is supplied by the host.
float jaLuma(vec3 color) { return sqrt(max(0.,dot(color,vec3(.2126,.7152,.0722)))); }
vec3 jaAntialias(highp sampler2D image,vec2 uv,vec2 resolution) {
  vec2 px=1./max(resolution,vec2(1.));
  vec3 center=JA_TEXTURE(image,uv).rgb;
  float m=jaLuma(center);
  float nw=jaLuma(JA_TEXTURE(image,uv+vec2(-1.,1.)*px).rgb);
  float ne=jaLuma(JA_TEXTURE(image,uv+vec2(1.,1.)*px).rgb);
  float sw=jaLuma(JA_TEXTURE(image,uv+vec2(-1.,-1.)*px).rgb);
  float se=jaLuma(JA_TEXTURE(image,uv+vec2(1.,-1.)*px).rgb);
  float lo=min(m,min(min(nw,ne),min(sw,se))),hi=max(m,max(max(nw,ne),max(sw,se)));
  if(hi-lo<max(.018,hi*.06)) return center;
  vec2 direction=vec2(-((nw+ne)-(sw+se)),((nw+sw)-(ne+se)));
  float reduce=max((nw+ne+sw+se)*.03125,.003125);
  direction=clamp(direction/(min(abs(direction.x),abs(direction.y))+reduce),vec2(-8.),vec2(8.))*px;
  vec3 a=.5*(JA_TEXTURE(image,uv+direction*(-1./6.)).rgb+JA_TEXTURE(image,uv+direction*(1./6.)).rgb);
  vec3 b=a*.5+.25*(JA_TEXTURE(image,uv-direction*.5).rgb+JA_TEXTURE(image,uv+direction*.5).rgb);
  float l=jaLuma(b);
  return l<lo||l>hi?a:b;
}
