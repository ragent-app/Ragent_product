//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"testing"
)

func TestMSIInspectionSignedFixture(t *testing.T) {
	path, publisher := os.Getenv("RAGENT_TEST_SIGNED_MSI"), os.Getenv("RAGENT_TEST_SIGNED_MSI_PUBLISHER_SHA256")
	if path == "" || publisher == "" {
		t.Skip("signed fixture not configured")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	request := msiInspectRequest{ArtifactPath: path, ArtifactSHA256: hex.EncodeToString(sum[:])}
	facts, err := inspectWindowsMSI(request)
	if err != nil || facts.PublisherSHA256 != publisher {
		t.Fatalf("inspection: %+v %v", facts, err)
	}
	server := &brokerIPCServer{msiInspector: inspectWindowsMSI}
	result := server.handleRequest(mustJSON(t, brokerRequest{Version: protocolVersion, Type: "msi_install.inspect", MSIInspect: &request}), false)
	if result.Type != "msi_install_inspection" || result.MSIFacts == nil || result.MSIFacts.PublisherSHA256 != publisher {
		t.Fatalf("IPC: %+v", result)
	}
	request.ArtifactSHA256 = publisher
	if _, err = inspectWindowsMSI(request); err == nil {
		t.Fatal("accepted incorrect digest")
	}
}
func TestMSIInspectionUnsignedFixture(t *testing.T) {
	path := os.Getenv("RAGENT_TEST_UNSIGNED_MSI")
	if path == "" {
		t.Skip("unsigned fixture not configured")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	facts, err := inspectWindowsMSI(msiInspectRequest{ArtifactPath: path, ArtifactSHA256: hex.EncodeToString(sum[:])})
	if err != nil || facts == nil || facts.PublisherSHA256 != unsignedMSIPublisher {
		t.Fatalf("unsigned inspection: %+v %v", facts, err)
	}
	prepared, err := prepareWindowsMSIInstall(msiInstallGrant{ArtifactPath: path, ArtifactSHA256: hex.EncodeToString(sum[:]), PublisherSHA256: unsignedMSIPublisher})
	if err != nil {
		t.Fatal(err)
	}
	prepared.Close()
}
