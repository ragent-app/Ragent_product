cmake_minimum_required(VERSION 3.22.1)
project(ragent_whisper LANGUAGES C CXX)

include(FetchContent)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_IS_DEV OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_ALL_WARNINGS OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_LTO OFF CACHE BOOL "" FORCE)
set(GGML_VULKAN OFF CACHE BOOL "" FORCE)
set(GGML_CUDA OFF CACHE BOOL "" FORCE)

# Pin the official upstream release commit so native binaries are reproducible.
FetchContent_Declare(
    whisper_cpp
    GIT_REPOSITORY https://github.com/ggml-org/whisper.cpp.git
    GIT_TAG d1be6fde11ac6e0407606b4e42fe72d34add8037
)
FetchContent_MakeAvailable(whisper_cpp)

find_library(android_log log)
add_library(ragent_whisper SHARED whisper_jni.cpp)
target_link_libraries(ragent_whisper PRIVATE whisper ${android_log} android)
target_compile_features(ragent_whisper PRIVATE cxx_std_17)
target_compile_options(ragent_whisper PRIVATE -O3 -fvisibility=hidden -ffunction-sections -fdata-sections)
target_link_options(ragent_whisper PRIVATE -Wl,--gc-sections -Wl,-z,max-page-size=16384)
