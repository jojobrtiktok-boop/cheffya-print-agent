// launcher.cs — Wrapper com ícone Cheffya real
// Compilado com csc.exe /target:winexe /win32icon:icon.ico
// Embute o cheffya-print-agent-core.exe como recurso gerenciado.
//
// Na primeira execução extrai o core para:
//   %LOCALAPPDATA%\CheffyaPrintAgent\cheffya-print-agent-core.exe
// e o inicia desacoplado (sem janela CMD).
// Arquivos extraídos pelo launcher NÃO herdam Zone.Identifier (Mark of the Web),
// portanto as chamadas PowerShell usadas na impressão funcionam sem bloqueio.

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

class CheffyaLauncher {
    [STAThread]
    static void Main() {
        try {
            // Diretório persistente do agente
            string appDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "CheffyaPrintAgent"
            );
            if (!Directory.Exists(appDir))
                Directory.CreateDirectory(appDir);

            string coreExe = Path.Combine(appDir, "cheffya-print-agent-core.exe");

            // Obtém stream do core embutido como recurso gerenciado
            using (Stream res = Assembly.GetExecutingAssembly()
                       .GetManifestResourceStream("CheffyaCore")) {
                if (res == null)
                    throw new Exception(
                        "Recurso 'CheffyaCore' não encontrado no launcher.\n" +
                        "Reconstrua o projeto com 'npm run build'.");

                // Extrai se o arquivo não existe ou tem tamanho diferente
                bool needsExtract = !File.Exists(coreExe)
                    || new FileInfo(coreExe).Length != res.Length;

                if (needsExtract) {
                    try {
                        using (FileStream fs = new FileStream(
                                   coreExe,
                                   FileMode.Create,
                                   FileAccess.Write,
                                   FileShare.None)) {
                            res.CopyTo(fs);
                        }
                    } catch (IOException) {
                        // Arquivo em uso — agente provavelmente já está rodando.
                        // Tenta iniciar assim mesmo; o core vai detectar a porta em uso e sair.
                    }
                }
            }

            // Inicia o core como processo independente (sem janela CMD)
            Process.Start(new ProcessStartInfo {
                FileName         = coreExe,
                UseShellExecute  = true,
                WorkingDirectory = appDir,
            });

        } catch (Exception ex) {
            MessageBox.Show(
                "Não foi possível iniciar o Cheffya Print Agent.\n\n" + ex.Message,
                "Cheffya Print Agent",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
        }
    }
}
