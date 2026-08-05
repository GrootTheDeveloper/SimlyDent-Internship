import os
import glob
import re
import codecs

footer_code = r'''
\noindent{\color{UMTnavy}\rule{\textwidth}{1.5pt}}\vspace{2pt}
\noindent\colorbox{UMTnavy}{\parbox[c][0.8cm][c]{\dimexpr\textwidth-2\fboxsep\relax}{\centering\textcolor{white}{\textbf{www.umt.edu.vn}}}}
'''

old_footer_pattern = re.compile(r'\\begin\{tikzpicture\}\[remember picture,overlay\].*?www\.umt\.edu\.vn.*?\\end\{tikzpicture\}', re.DOTALL)

for tex_file in glob.glob('*.tex'):
    if 'Bao_cao_thuc_tap.tex' in tex_file:
        continue # already fixed

    with codecs.open(tex_file, 'r', 'utf-8') as f:
        content = f.read()

    # 1. Add \densedotfill to preamble
    if r'\newcommand{\densedotfill}' not in content:
        content = content.replace(r'\begin{document}', r'\newcommand{\densedotfill}{\leavevmode\cleaders\hbox{.\hspace{1.5pt}}\hfill\kern0pt}' + '\n\n' + r'\begin{document}')

    # 2. Replace \dotfill with \densedotfill
    content = content.replace(r'\dotfill', r'\densedotfill')

    # 3. Replace old tikz footer with new footer
    if old_footer_pattern.search(content):
        content = old_footer_pattern.sub(footer_code.strip(), content)

    # 4. In case they used \dots for filling
    # Be careful not to replace \dots used for text like KHOA ......
    # We will just leave \dots alone to be safe.

    with codecs.open(tex_file, 'w', 'utf-8') as f:
        f.write(content)
print("Patching complete.")
