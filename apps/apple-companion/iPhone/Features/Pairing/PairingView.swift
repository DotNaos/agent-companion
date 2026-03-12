import SwiftUI

struct PairingView: View {
    @ObservedObject var model: PhoneAppModel
    @State private var showScanner = false

    var body: some View {
        Form {
            Section("Server") {
                TextField("http://192.168.1.20:4318", text: $model.serverURLText)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
            }

            Section("Pairing") {
                TextField("Pairing-Code", text: $model.pairingCode)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                Button("QR scannen") {
                    showScanner = true
                }
                Button {
                    Task {
                        await model.pairDevice()
                    }
                } label: {
                    if model.isBusy {
                        ProgressView()
                    } else {
                        Text("Mit Laptop verbinden")
                    }
                }
                .disabled(model.isBusy || model.pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            Section("Hinweis") {
                Text("Den Pairing-Code erzeugst du im Desktop Companion. Danach lädt die iPhone-App Bootstrap, Sessions und History direkt vom Laptop-Gateway.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Pluto verbinden")
        .sheet(isPresented: $showScanner) {
            PairingScannerView { payload in
                _ = model.applyPairingScan(payload)
            }
        }
    }
}
