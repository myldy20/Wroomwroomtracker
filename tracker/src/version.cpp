#include "version.h"

#ifdef WEB_BUILD
const char* appTitle = "WroomWroomTracker";
#else
const char* appTitle = "ChooChooTracker";
#endif
const char* appVersion = "1.0.15-alpha";
const char* appBuild = __DATE__ " " __TIME__;
