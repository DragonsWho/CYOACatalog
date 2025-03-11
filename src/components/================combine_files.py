import os
import re

def clean_code(content):
    """Очищает код от лишних пробелов и пустых строк."""
    lines = [line.rstrip() for line in content.split('\n')]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return '\n'.join(lines)

def generate_directory_structure(root_dir, indent=0):
    """Генерирует текстовое представление структуры директорий и файлов."""
    structure = []
    for item in sorted(os.listdir(root_dir)):
        item_path = os.path.join(root_dir, item)
        if os.path.isdir(item_path):
            structure.append('  ' * indent + '>' + item)
            structure.extend(generate_directory_structure(item_path, indent + 1))
        else:
            # Пропускаем ненужные файлы в структуре (как и в основном скрипте)
            if not item.endswith(('.lock', '.lockb', '.gitignore', '.nix', '.go', '.html', '.md')) and \
               not item.startswith('bun.') and \
               not item.startswith('flake.'):
                structure.append('  ' * indent + ' ' + item)
    return structure

def process_file(file_path, output_file):
    """Обрабатывает файл и добавляет его содержимое в выходной файл с комментарием."""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        relative_path = os.path.relpath(file_path, os.getcwd())
        
        comment = f"\n// === File: {relative_path} ===\n\n"
        cleaned_content = clean_code(content)
        output_file.write(comment + cleaned_content + '\n\n')
        
    except Exception as e:
        print(f"Ошибка при обработке файла {file_path}: {e}")

def combine_files(root_dir, output_file_path="================combined.txt"):
    """Объединяет все файлы в указанной директории в один файл с добавлением структуры папок."""
    # Генерируем структуру директорий
    dir_structure = generate_directory_structure(root_dir)
    
    # Создаём или очищаем выходной файл
    with open(output_file_path, 'w', encoding='utf-8') as output_file:
        # Добавляем структуру файлов и папок в начале как комментарий
        output_file.write("// === Project Directory Structure ===\n")
        for line in dir_structure:
            output_file.write(f"// {line}\n")
        output_file.write("// === End of Directory Structure ===\n\n")
        
        # Рекурсивно обходим директорию и добавляем файлы
        for root, _, files in os.walk(root_dir):
            for file in files:
                file_path = os.path.join(root, file)
                # Пропускаем ненужные файлы
                if file.endswith(('.lock', '.lockb', '.gitignore', '.nix', '.go', '.html', '.md')) or \
                   file.startswith('bun.') or \
                   file.startswith('flake.'):
                    continue
                
                # Обрабатываем только текстовые файлы проекта
                if file.endswith(('.tsx', '.ts', '.js', '.jsx', '.css', '.json')):
                    process_file(file_path, output_file)
    
    print(f"Файлы успешно объединены в {output_file_path}")

if __name__ == "__main__":
    # Укажите корневую директорию вашего проекта (например, текущая директория или путь к 'src')
    root_directory = "CyoaPage"
    combine_files(root_directory)