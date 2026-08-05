import codecs
import re

with codecs.open('Bao_cao_thuc_tap.tex', 'r', 'utf-8') as f:
    bao_cao = f.read()

cover_page = bao_cao.split(r'\end{document}')[0].strip()

# Now patch Phieu_nhan_xet
with codecs.open('Phieu_nhan_xet_don_vi_thuc_tap.tex', 'r', 'utf-8') as f:
    phieu_nx = f.read()
if '% PAGE 2' in phieu_nx:
    page2_and_3 = phieu_nx.split('% PAGE 2')[1]
    new_phieu_nx = cover_page + '\n\n% PAGE 2' + page2_and_3
    with codecs.open('Phieu_nhan_xet_don_vi_thuc_tap.tex', 'w', 'utf-8') as f:
        f.write(new_phieu_nx)

# Now patch Phieu_ghi_nhan
with codecs.open('Phieu_ghi_nhan_qua_trinh_thuc_hien.tex', 'r', 'utf-8') as f:
    phieu_gn = f.read()
if '% PAGE 2' in phieu_gn:
    page2_and_3 = phieu_gn.split('% PAGE 2')[1]
    new_phieu_gn = cover_page + '\n\n% PAGE 2' + page2_and_3
    with codecs.open('Phieu_ghi_nhan_qua_trinh_thuc_hien.tex', 'w', 'utf-8') as f:
        f.write(new_phieu_gn)

