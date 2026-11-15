package com.andysagent.ragent;
interface IDocumentExportCallback {
    boolean authorize(String attempt);
    oneway void completed(String attempt, String errorCode, long bytes);
}
