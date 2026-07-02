// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-10.
//

#ifdef _WINDOWS
#include <fcntl.h>
#include <windows.h>
#else

#include <sys/fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/types.h>

#endif // _WINDOWS

#include <kungfu/common.h>
#include <kungfu/yijinjing/journal/common.h>
#include <kungfu/yijinjing/util/os.h>

using namespace kungfu::yijinjing::journal;

namespace kungfu::yijinjing::os {

uintptr_t load_mmap_buffer(const std::string &path, size_t size, bool is_writing, bool lazy) {
#ifdef _WINDOWS
  bool is_master = is_writing || !lazy;
  HANDLE dumpFileDescriptor = CreateFileA(path.c_str(), (is_master) ? (GENERIC_READ | GENERIC_WRITE) : GENERIC_READ,
                                          FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                                          (is_master) ? OPEN_ALWAYS : OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (dumpFileDescriptor == INVALID_HANDLE_VALUE) {
    throw journal_error("unable to mmap for page " + path);
  }

  // https://learn.microsoft.com/zh-cn/windows/win32/memory/creating-a-file-mapping-object?redirectedfrom=MSDN
  // max journal size is 2GB in Windows
  HANDLE fileMappingObject =
      CreateFileMapping(dumpFileDescriptor, NULL, (is_master) ? PAGE_READWRITE : PAGE_READONLY, 0, size, NULL);

  if (fileMappingObject == NULL) {
    int nRet = GetLastError();
    SPDLOG_ERROR("{} CreateFileMapping Error = {}, {}\n", is_master ? "writer" : "reader", nRet, path);
    throw journal_error("unable to mmap for page " + path);
  }

  void *buffer = MapViewOfFile(fileMappingObject, (is_master) ? FILE_MAP_ALL_ACCESS : FILE_MAP_READ, 0, 0, size);

  if (buffer == nullptr) {
    int nRet = GetLastError();
    throw journal_error("failed to load page " + path + ", MapViewOfFile Error " + std::to_string(nRet));
  }
  CloseHandle(fileMappingObject);
  CloseHandle(dumpFileDescriptor);
#else
  bool is_master = is_writing || !lazy;
  int fd = open(path.c_str(), (is_master ? O_RDWR : O_RDONLY) | O_CREAT, (mode_t)0600);
  if (fd < 0) {
    throw journal_error("failed to open file for page " + path + ", errno: " + strerror(errno));
  }

  if (is_master) {
    if (lseek(fd, size - 1, SEEK_SET) == -1) {
      close(fd);
      throw journal_error("failed to stretch for page " + path + ", errno: " + strerror(errno));
    }
    if (write(fd, "", 1) == -1) {
      close(fd);
      throw journal_error("unable to write for page " + path + ", errno: " + strerror(errno));
    }
  }

  /**
   * MAP_FIXED is dup2 for memory mappings, and it's useful in exactly the same situations where dup2 is useful for file
   * descriptors: when you want to perform a replace operation that atomically reassigns a resource identifier (memory
   * range in the case of MAP_FIXED, or fd in the case of dup2) to refer to a new resource without the possibility of
   * races where it might get reassigned to something else if you first released the old resource then attempted to
   * regain it for the new resource.
   */
  void *buffer = mmap(0, size, is_master ? (PROT_READ | PROT_WRITE) : PROT_READ, MAP_SHARED, fd, 0);

  if (buffer == MAP_FAILED) {
    close(fd);
    throw journal_error("Error mapping file to buffer: " + path);
  }

  if (!lazy && madvise(buffer, size, MADV_RANDOM) != 0 && mlock(buffer, size) != 0) {
    munmap(buffer, size);
    close(fd);
    throw journal_error("failed to lock memory for page " + path);
  }

  close(fd);
#endif // _WINDOWS
  return reinterpret_cast<uintptr_t>(buffer);
}

bool flush_mmap_buffer(uintptr_t address, size_t size, bool lazy) {
  void *buffer = reinterpret_cast<void *>(address);
#ifdef _WINDOWS
  FlushViewOfFile(buffer, 0);
#else
  if (msync(buffer, size, MS_SYNC) != 0) {
    return false;
  }
#endif
  return true;
}

bool release_mmap_buffer(uintptr_t address, size_t size, bool lazy) {
  void *buffer = reinterpret_cast<void *>(address);
#ifdef _WINDOWS
  FlushViewOfFile(buffer, 0);
  UnmapViewOfFile(buffer);
#else
  // unlock and unmap
  if (!lazy && munlock(buffer, size) != 0) {
    return false;
  }

  if (munmap(buffer, size) != 0) {
    return false;
  }
#endif // _WINDOWS
  return true;
}

} // namespace kungfu::yijinjing::os
