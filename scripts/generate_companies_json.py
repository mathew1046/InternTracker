import csv
import json
import sys

input_csv = sys.argv[1] if len(sys.argv) > 1 else 'data/infopark_companies_categorized.csv'
output_json = sys.argv[2] if len(sys.argv) > 2 else 'worker/src/companies.json'

rows = []
with open(input_csv, 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        name = row.get('Name', '').strip()
        if not name:
            continue
        rows.append({
            'name': name,
            'category': row.get('Category', '').strip(),
            'address': row.get('Address', '').strip(),
            'phone': row.get('Phone', '').strip(),
            'email': row.get('Email', '').strip(),
            'website': row.get('Website', '').strip(),
            'short_description': row.get('Short Description', '').strip()
        })

with open(output_json, 'w', encoding='utf-8') as f:
    json.dump(rows, f, ensure_ascii=False, indent=0)

print(f'Generated {output_json} with {len(rows)} companies')